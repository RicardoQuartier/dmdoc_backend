"""Microserviço de extração de texto do DMDoc (Python).

Substitui o Unstructured e o NativeExtractor (Node): um único serviço que extrai
texto de todos os formatos suportados, com OCR de alta qualidade para scans.

Modos de operação:
  - Fila Redis (primário): consumer loop BRPOP em 'extract:requests'; baixa o
    arquivo do S3 diretamente; publica resultado em 'extract:result:{requestId}'.
    Elimina timeout HTTP — o worker aguarda via BLPOP sem limite de tempo.
  - Endpoint HTTP /extract (legado): mantido para compatibilidade e testes manuais.
  - Endpoint HTTP /convert/pdf: conversão Office→PDF para preview, não afetado.

Dispatch por formato:
- PDF   → PyMuPDF (texto nativo); páginas escaneadas (sem texto) caem para OCR
- JPG/PNG/WebP → OCR (EasyOCR) com remoção de borda branca + auto-rotação
- DOCX  → python-docx (parágrafos + tabelas) + OCR de imagens embutidas
- XLSX  → openpyxl (células por planilha)
- PPTX  → python-pptx (texto dos slides)

OCR: auto-rotação em 2 etapas baratas (detector nas 4 rotações de miniatura →
reconhecimento só nos 2 candidatos) + OCR full-res 1×. Resolve scans girados
sem fazer 4 passadas em alta resolução (causa de OOM).
"""

import asyncio
import io
import json
import logging
import os
import subprocess
import tempfile
import threading
import zipfile

import boto3
import redis as redis_lib

import cv2
import torch
import easyocr
import fitz  # PyMuPDF
import numpy as np

# Backend quantizado do PyTorch. O modelo de reconhecimento do EasyOCR usa
# quantização dinâmica (qlinear_dynamic). O backend padrão 'onednn' (e o
# alternativo 'fbgemm') emitem kernels AVX2/FMA — que QUEBRAM com SIGILL
# (exit 132) em CPUs antigas como Ivy Bridge (i3 3ª geração: AVX sim,
# AVX2/FMA não). O 'qnnpack' é o backend portátil (originalmente para ARM)
# e roda no x86 sem AVX2. Mais lento, porém universal — sem ele a inferência
# derruba o container assim que recebe a primeira imagem. Complementa o
# ATEN_CPU_CAPABILITY=default do docker-compose, que só cobre os kernels
# não-quantizados do ATen.
if "qnnpack" in torch.backends.quantized.supported_engines:
    torch.backends.quantized.engine = "qnnpack"
from docx import Document as DocxDocument
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl import load_workbook
from pptx import Presentation

logger = logging.getLogger("dmdoc.extractor")
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter("%(levelname)-8s %(name)s - %(message)s"))
logger.addHandler(_handler)
logger.setLevel(logging.INFO)
logger.propagate = False

LANGS = os.environ.get("OCR_LANGS", "pt").split(",")

# Timeout máximo (segundos) para o endpoint /extract legado (HTTP direto).
# O consumer Redis não usa este timeout — processa sem limite de tempo.
REQUEST_TIMEOUT_S = int(os.environ.get("EXTRACT_TIMEOUT_S", "120"))

# Configuração do consumer Redis
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "dmdoc-documents")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
# TTL do result key no Redis — cleanup automático se o worker morrer antes de ler.
RESULT_KEY_TTL_SECS = 3600
EXTRACT_REQUEST_QUEUE = "extract:requests"
EXTRACT_RESULT_PREFIX = "extract:result:"

# Semáforo global que serializa jobs de OCR. OCR em CPU não tem ganho real de
# paralelismo (afinal é single-threaded no PyTorch), mas consome ~1-2 GiB por job.
# Limitar a 1 job simultâneo é a forma mais simples de manter o pico de RAM
# previsível, sem depender de filas externas.
_ocr_semaphore = asyncio.Semaphore(1)

# Mapeamento content-type → extensão de arquivo para conversão Office→PDF.
OFFICE_EXTENSIONS: dict[str, str] = {
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.oasis.opendocument.presentation": ".odp",
    "application/vnd.oasis.opendocument.text": ".odt",
    "text/rtf": ".rtf",
    "application/rtf": ".rtf",
}

# Resolução máxima enviada ao OCR (maior lado, px). Reduzido de 2048 → 1600:
# em scans de identidade (RG/CNH) 1600px no maior lado preserva os campos-chave
# (nome, números, órgão) com folga para o OCR, mas corta ~40% do número de pixels
# vs 2048 (1600²/2048² ≈ 0.61) — alívio direto de memória e tempo no EasyOCR, que
# é O(pixels). Acurácia nos campos grandes de um documento de identidade é
# praticamente inalterada nessa faixa.
MAX_DIM = 1600
# Maior lado (px) da MINIATURA usada na 1ª etapa da detecção de orientação. Nessa
# etapa rodamos só o DETECTOR do EasyOCR (CRAFT, sem reconhecimento) nas 4 rotações
# — barato — para contar caixas de texto e escolher os 2 ângulos candidatos.
ORIENT_DIM = 640
# Quantas orientações candidatas (as de maior nº de caixas detectadas) passam para a
# 2ª etapa. O detector não distingue 0°↔180° nem 90°↔270° (caixas idênticas de
# cabeça pra baixo), então levamos 2 candidatos ao reconhecimento para desambiguar
# por texto real (len×confiança). Resultado: 4× detect (barato) + 2× reconhecimento
# numa thumb, em vez de 4× reconhecimento full-res.
ORIENT_CANDIDATES = 2
# Teto explícito para o canvas interno do EasyOCR. O default do EasyOCR é
# canvas_size=2560: se a imagem for menor ele faz UPSCALE até esse tamanho antes da
# detecção, inflando memória sem ganho. Travamos o canvas no maior lado real (com
# teto MAX_DIM) e mag_ratio=1.0 para proibir qualquer ampliação interna.
OCR_CANVAS_CAP = MAX_DIM
# Limiar de grayscale: pixel < CONTENT_THRESHOLD conta como conteúdo (não-branco).
CONTENT_THRESHOLD = 220
# Mínimo de caracteres alfanuméricos numa página de PDF para considerá-la "nativa"
# (com camada de texto). Abaixo disso, a página é tratada como escaneada → OCR.
MIN_PAGE_ALNUM = 20

# MIMEs e extensões de imagem suportados pelo cv2.imdecode (libwebp embutida).
_IMAGE_MIMES = frozenset({
    "image/jpeg", "image/png", "image/webp",
    "image/gif", "image/bmp", "image/tiff", "image/tif",
})
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif")

_ROTATIONS = {
    0: None,
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

_reader = easyocr.Reader(LANGS, gpu=False)

app = FastAPI(title="DMDoc Extractor", version="1.0.0")


# ──────────────────────────── Redis consumer ────────────────────────────


def _make_s3_client():
    kwargs = dict(
        region_name=AWS_REGION,
        aws_access_key_id=AWS_ACCESS_KEY_ID or None,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY or None,
    )
    if S3_ENDPOINT:
        kwargs["endpoint_url"] = S3_ENDPOINT
    return boto3.client("s3", **kwargs)


def _extraction_consumer_loop() -> None:
    """Consumer Redis que processa pedidos de extração sem timeout HTTP.

    Roda em thread background (daemon=True) iniciada no startup do FastAPI.
    BRPOP bloqueia indefinidamente até chegar um pedido; processa um job por vez,
    serializando OCR naturalmente sem necessidade de asyncio.Semaphore.
    Em erro de conexão: dorme 5s e reconecta.
    Em erro de extração: publica {error} no result key para o worker não ficar preso.
    """
    import time

    rconn = redis_lib.from_url(REDIS_URL, decode_responses=True)
    s3 = _make_s3_client()
    logger.info("extraction consumer loop iniciado (fila=%s)", EXTRACT_REQUEST_QUEUE)

    while True:
        try:
            item = rconn.brpop(EXTRACT_REQUEST_QUEUE, timeout=0)
            if item is None:
                continue

            _, raw = item
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                logger.error("payload JSON inválido na fila: %.200s — %s", raw, exc)
                continue

            request_id = payload.get("requestId", "")
            s3_key = payload.get("s3Key", "")
            s3_bucket = payload.get("s3Bucket", S3_BUCKET)
            mime = payload.get("mimeType", "")
            result_key = f"{EXTRACT_RESULT_PREFIX}{request_id}"

            logger.info(
                "extraindo requestId=%s s3Key=%s mime=%s",
                request_id, s3_key, mime,
            )

            try:
                s3_resp = s3.get_object(Bucket=s3_bucket, Key=s3_key)
                data = s3_resp["Body"].read()
                name = s3_key.split("/")[-1].lower()
                result = _dispatch_extract(data, mime, name)
                result["engine"] = "python"
                out = json.dumps(result)
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "falha ao processar requestId=%s s3Key=%s: %s",
                    request_id, s3_key, exc,
                )
                out = json.dumps({"error": str(exc), "text": "", "pageCount": 1, "ocrPages": []})

            pipe = rconn.pipeline()
            pipe.rpush(result_key, out)
            pipe.expire(result_key, RESULT_KEY_TTL_SECS)
            pipe.execute()
            logger.info("resultado publicado requestId=%s", request_id)

        except redis_lib.exceptions.ConnectionError as exc:
            logger.error(
                "Redis connection error no consumer loop: %s — reconectando em 5s", exc
            )
            time.sleep(5)
            try:
                rconn = redis_lib.from_url(REDIS_URL, decode_responses=True)
                s3 = _make_s3_client()
            except Exception:  # noqa: BLE001
                logger.exception("falha ao reconectar Redis/S3")
        except Exception as exc:  # noqa: BLE001
            logger.exception("erro inesperado no consumer loop: %s", exc)
            time.sleep(1)


@app.on_event("startup")
def _start_consumer() -> None:
    t = threading.Thread(
        target=_extraction_consumer_loop,
        daemon=True,
        name="extraction-consumer",
    )
    t.start()
    logger.info("extraction consumer thread iniciado")


# ──────────────────────────── OCR ────────────────────────────


def _crop_white(img: np.ndarray) -> np.ndarray:
    """Recorta a borda branca (folha em volta do documento) via bbox de pixels
    não-brancos, com mediana para ignorar sujeira isolada no branco."""
    h, w = img.shape[:2]
    if w == 0 or h == 0:
        return img
    sw = 200
    sh = max(1, round(h / w * sw))
    thumb = cv2.cvtColor(cv2.resize(img, (sw, sh)), cv2.COLOR_BGR2GRAY)
    thumb = cv2.medianBlur(thumb, 5)
    ys, xs = np.where(thumb < CONTENT_THRESHOLD)
    if xs.size < 50:
        return img
    minx, maxx, miny, maxy = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    sx, sy, pad = w / sw, h / sh, 4
    left = max(0, int((minx - pad) * sx))
    top = max(0, int((miny - pad) * sy))
    right = min(w, int((maxx + pad) * sx))
    bot = min(h, int((maxy + pad) * sy))
    if right <= left or bot <= top:
        return img
    if (right - left) * (bot - top) >= w * h * 0.95:
        return img
    return img[top:bot, left:right]


def _resize(img: np.ndarray, max_dim: int) -> np.ndarray:
    """Reduz a imagem para que o maior lado seja no máximo `max_dim` (nunca amplia)."""
    h, w = img.shape[:2]
    scale = min(max_dim / max(h, w), 1.0)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _ocr_once(img: np.ndarray) -> tuple[list[str], list[float], float]:
    """Roda o EasyOCR uma vez, com o canvas interno travado no tamanho real da
    imagem (teto OCR_CANVAS_CAP) e mag_ratio=1.0 para proibir upscaling — o que
    evita a explosão de memória do default canvas_size=2560."""
    h, w = img.shape[:2]
    canvas = min(max(h, w), OCR_CANVAS_CAP)
    # canvas_size precisa ser >= 32 para o EasyOCR; thumbs pequenas ainda passam.
    canvas = max(canvas, 32)
    result = _reader.readtext(
        img,
        detail=1,
        paragraph=False,
        canvas_size=canvas,
        mag_ratio=1.0,
    )
    lines: list[str] = []
    confs: list[float] = []
    score = 0.0
    for item in result or []:
        try:
            text = item[1].strip()
            conf = float(item[2])
        except (IndexError, TypeError, ValueError, AttributeError):
            continue
        if text:
            lines.append(text)
            confs.append(conf)
            score += len(text) * conf
    return lines, confs, score


def _detect_box_count(img: np.ndarray, canvas: int) -> int:
    """Conta caixas de texto usando SÓ o detector do EasyOCR (CRAFT, sem o passo de
    reconhecimento, que é o caro). É o sinal barato de orientação."""
    try:
        result = _reader.detect(img, canvas_size=canvas, mag_ratio=1.0)
    except Exception:  # noqa: BLE001 — detecção é best-effort
        return 0
    if not result:
        return 0
    horizontal = result[0]
    boxes = horizontal[0] if horizontal else []
    return len(boxes or [])


def _candidate_rotations(img: np.ndarray) -> list[int | None]:
    """1ª etapa da orientação: roda só o DETECTOR nas 4 rotações de uma miniatura e
    devolve os ORIENT_CANDIDATES ângulos com mais caixas de texto. Barato (sem
    reconhecimento). O detector não distingue 0°↔180° nem 90°↔270°, por isso vários
    candidatos seguem para o reconhecimento."""
    thumb = _resize(img, ORIENT_DIM)
    canvas = max(min(max(thumb.shape[:2]), OCR_CANVAS_CAP), 32)
    scored: list[tuple[int, int | None]] = []
    for code in _ROTATIONS.values():
        rotated = thumb if code is None else cv2.rotate(thumb, code)
        scored.append((_detect_box_count(rotated, canvas), code))
    scored.sort(key=lambda x: x[0], reverse=True)
    candidates = [code for _count, code in scored[:ORIENT_CANDIDATES]]
    return candidates or [None]


def _best_rotation(img: np.ndarray) -> int | None:
    """2ª etapa da orientação: entre os candidatos do detector, roda o RECONHECIMENTO
    numa miniatura para desambiguar (ex.: 0° vs 180°) e escolhe o de maior score
    (len×confiança). Retorna o código cv2.rotate (ou None para 0°)."""
    candidates = _candidate_rotations(img)
    if len(candidates) == 1:
        return candidates[0]
    thumb = _resize(img, ORIENT_DIM)
    best_code: int | None = candidates[0]
    best_score = -1.0
    for code in candidates:
        rotated = thumb if code is None else cv2.rotate(thumb, code)
        _lines, _confs, score = _ocr_once(rotated)
        if score > best_score:
            best_score = score
            best_code = code
    return best_code


def ocr_image(img: np.ndarray) -> str:
    """OCR completo e robusto:
    1. recorta a borda branca;
    2. detecta a orientação em 2 etapas baratas (detector nas 4 rotações de uma
       miniatura → reconhecimento só nos 2 candidatos), preservando a auto-rotação;
    3. roda o OCR FULL uma única vez na melhor orientação, em MAX_DIM.

    Antes o OCR rodava 4× em alta resolução só para achar a orientação — causa do
    OOM/lentidão. Agora são 4× detect (barato) + 2× reconhecimento em miniatura +
    1× reconhecimento full-res.

    Toda a etapa de OCR é protegida por try/except: uma imagem patológica retorna
    texto vazio + log, em vez de derrubar o worker uvicorn (e com ele o serviço)."""
    try:
        cropped = _crop_white(img)
        best_code = _best_rotation(cropped)
        full = _resize(cropped, MAX_DIM)
        if best_code is not None:
            full = cv2.rotate(full, best_code)
        lines, _confs, _score = _ocr_once(full)
        return "\n".join(lines)
    except Exception:  # noqa: BLE001 — guarda de robustez: nunca derrubar o serviço
        logger.exception("ocr_image falhou; retornando texto vazio para este item")
        return ""


# ──────────────────────────── extração por formato ────────────────────────────


def _libreoffice_to_pdf(data: bytes, ext: str) -> bytes:
    """Converte documento Office/RTF para PDF via LibreOffice headless."""
    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"input{ext}")
        with open(input_path, "wb") as f:
            f.write(data)
        try:
            result = subprocess.run(
                ["libreoffice", "--headless", "--norestore",
                 "--convert-to", "pdf", "--outdir", tmpdir, input_path],
                capture_output=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            return b""
        if result.returncode != 0:
            return b""
        pdf_name = os.path.basename(input_path).rsplit(".", 1)[0] + ".pdf"
        pdf_path = os.path.join(tmpdir, pdf_name)
        if not os.path.exists(pdf_path):
            return b""
        with open(pdf_path, "rb") as f:
            return f.read()


def extract_txt(data: bytes) -> dict:
    text = data.decode("utf-8", errors="replace")
    return {"text": text, "pageCount": 1, "ocrPages": []}


def extract_pdf(data: bytes) -> dict:
    doc = fitz.open(stream=data, filetype="pdf")
    texts: list[str] = []
    ocr_pages: list[int] = []
    for i in range(doc.page_count):
        page = doc[i]
        text = page.get_text().strip()
        alnum = sum(c.isalnum() for c in text)
        if alnum >= MIN_PAGE_ALNUM:
            texts.append(text)
        else:
            pix = page.get_pixmap(dpi=200)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
            if pix.n == 4:
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif pix.n == 3:
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            else:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
            ocr_text = ocr_image(img)
            if ocr_text:
                texts.append(ocr_text)
            ocr_pages.append(i + 1)
    return {
        "text": "\n\n".join(t for t in texts if t),
        "pageCount": doc.page_count or 1,
        "ocrPages": ocr_pages,
    }


def extract_image(data: bytes) -> dict:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"text": "", "pageCount": 1, "ocrPages": []}
    return {"text": ocr_image(img), "pageCount": 1, "ocrPages": [1]}


def extract_docx(data: bytes) -> dict:
    doc = DocxDocument(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append("\t".join(cells))

    # OCR de imagens embutidas (word/media/*) — equivalente ao docx-images do Node.
    ocr_texts: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for name in zf.namelist():
                if name.startswith("word/media/") and name.lower().endswith(
                    (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif")
                ):
                    img = cv2.imdecode(np.frombuffer(zf.read(name), np.uint8), cv2.IMREAD_COLOR)
                    if img is not None:
                        t = ocr_image(img)
                        if t.strip():
                            ocr_texts.append(t)
    except (zipfile.BadZipFile, KeyError):
        pass

    blocks = [b for b in ["\n".join(parts), "\n\n".join(ocr_texts)] if b.strip()]
    return {
        "text": "\n\n".join(blocks),
        "pageCount": 1,
        "ocrPages": [1] if ocr_texts else [],
    }


def extract_xlsx(data: bytes) -> dict:
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    sheet_count = len(wb.worksheets)
    for ws in wb.worksheets:
        parts.append(f"# {ws.title}")
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) for c in row if c is not None]
            if cells:
                parts.append("\t".join(cells))
    wb.close()
    return {"text": "\n".join(parts), "pageCount": sheet_count or 1, "ocrPages": []}


def extract_pptx(data: bytes) -> dict:
    prs = Presentation(io.BytesIO(data))
    parts: list[str] = []
    slides = list(prs.slides)
    for slide in slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    txt = "".join(run.text for run in para.runs)
                    if txt.strip():
                        parts.append(txt)
    return {"text": "\n".join(parts), "pageCount": len(slides) or 1, "ocrPages": []}


# ──────────────────────────── endpoints ────────────────────────────


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "langs": LANGS}


def _dispatch_extract(data: bytes, mime: str, name: str) -> dict:
    """Despacha a extração para o handler correto com base no MIME/nome do arquivo.
    Função síncrona; chamada via asyncio.to_thread() pelo endpoint /extract."""
    if mime == "application/pdf" or name.endswith(".pdf"):
        return extract_pdf(data)
    if mime in _IMAGE_MIMES or name.endswith(_IMAGE_EXTS):
        return extract_image(data)
    if "wordprocessingml" in mime or name.endswith(".docx"):
        return extract_docx(data)
    if "spreadsheetml" in mime or name.endswith(".xlsx"):
        return extract_xlsx(data)
    if "presentationml" in mime or name.endswith(".pptx"):
        return extract_pptx(data)
    if mime == "application/msword" or name.endswith(".doc"):
        pdf = _libreoffice_to_pdf(data, ".doc")
        return extract_pdf(pdf) if pdf else {"text": "", "pageCount": 1, "ocrPages": []}
    if mime == "application/vnd.ms-excel" or name.endswith(".xls"):
        pdf = _libreoffice_to_pdf(data, ".xls")
        return extract_pdf(pdf) if pdf else {"text": "", "pageCount": 1, "ocrPages": []}
    if mime == "application/vnd.ms-powerpoint" or name.endswith(".ppt"):
        pdf = _libreoffice_to_pdf(data, ".ppt")
        return extract_pdf(pdf) if pdf else {"text": "", "pageCount": 1, "ocrPages": []}
    if mime in ("text/rtf", "application/rtf") or name.endswith(".rtf"):
        pdf = _libreoffice_to_pdf(data, ".rtf")
        return extract_pdf(pdf) if pdf else {"text": "", "pageCount": 1, "ocrPages": []}
    if mime == "text/plain" or name.endswith(".txt"):
        return extract_txt(data)
    if mime.startswith("video/") or mime.startswith("audio/") or name.endswith(
        (".mp4", ".avi", ".mov", ".mkv", ".webm", ".3gp", ".mp3", ".m4a")
    ):
        return {"text": "", "pageCount": 1, "ocrPages": []}
    return {"text": "", "pageCount": 1, "ocrPages": [], "error": f"unsupported mime: {mime}"}


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    content_type: str = Form(default=""),
) -> dict:
    """Extrai texto do documento recebido.

    - Corre no ThreadPoolExecutor via asyncio.to_thread() para não bloquear o
      event loop do uvicorn durante OCR em CPU (30-120s num scan de identidade).
      Isso garante que GET /health continue respondendo e o healthcheck do Docker
      não dispare reinícios desnecessários.
    - O asyncio.Semaphore(1) serializa jobs de OCR: nunca dois OCRs simultâneos,
      evitando pico duplo de RAM.
    - REQUEST_TIMEOUT_S: se o processamento ultrapassar o limite, devolve HTTP 503
      com mensagem descritiva, em vez de prender a conexão indefinidamente.
    """
    data = await file.read()
    mime = content_type or file.content_type or ""
    name = (file.filename or "").lower()

    async def _run() -> dict:
        async with _ocr_semaphore:
            return await asyncio.to_thread(_dispatch_extract, data, mime, name)

    try:
        out = await asyncio.wait_for(_run(), timeout=REQUEST_TIMEOUT_S)
    except asyncio.TimeoutError:
        logger.error(
            "extract timeout após %ds: mime=%s name=%s bytes=%d",
            REQUEST_TIMEOUT_S, mime, name, len(data),
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"extração excedeu o tempo limite de {REQUEST_TIMEOUT_S}s — "
                "documento muito grande ou OCR lento demais neste ambiente"
            ),
        )

    out["engine"] = "python"
    return out


@app.post("/convert/pdf")
async def convert_to_pdf(
    file: UploadFile = File(...),
    content_type: str = Form(default=""),
) -> Response:
    """Converte documento Office para PDF usando LibreOffice headless."""
    data = await file.read()
    mime = content_type or file.content_type or ""
    name = (file.filename or "").lower()

    ext = OFFICE_EXTENSIONS.get(mime, "")
    if not ext:
        for suffix in OFFICE_EXTENSIONS.values():
            if name.endswith(suffix):
                ext = suffix
                break
    if not ext:
        raise HTTPException(
            status_code=422,
            detail=f"formato não suportado para conversão: {mime or name}",
        )

    pdf_bytes = _libreoffice_to_pdf(data, ext)
    if not pdf_bytes:
        raise HTTPException(status_code=500, detail="falha na conversão do documento")

    return Response(content=pdf_bytes, media_type="application/pdf")
