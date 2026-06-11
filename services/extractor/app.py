"""Microserviço de extração de texto do DMDoc (Python).

Substitui o Unstructured e o NativeExtractor (Node): um único serviço que extrai
texto de todos os formatos suportados, com OCR de alta qualidade para scans.

Endpoint: POST /extract  (multipart: file + content_type)
Resposta: { text, pageCount, ocrPages: [int], engine: "python" }

Dispatch por formato:
- PDF   → PyMuPDF (texto nativo); páginas escaneadas (sem texto) caem para OCR
- JPG/PNG → OCR (EasyOCR) com remoção de borda branca + auto-rotação
- DOCX  → python-docx (parágrafos + tabelas) + OCR de imagens embutidas
- XLSX  → openpyxl (células por planilha)
- PPTX  → python-pptx (texto dos slides)

OCR: o EasyOCR não recusa documentos de identidade (ao contrário de LLMs) e a
auto-rotação testa os 4 ângulos da imagem inteira, escolhendo o de texto mais
coerente — resolve scans girados (RG digitalizado de lado).
"""

import io
import os
import zipfile

import cv2
import easyocr
import fitz  # PyMuPDF
import numpy as np
from docx import Document as DocxDocument
from fastapi import FastAPI, File, Form, UploadFile
from openpyxl import load_workbook
from pptx import Presentation

LANGS = os.environ.get("OCR_LANGS", "pt").split(",")

# Resolução máxima enviada ao OCR (maior lado, px).
MAX_DIM = 2048
# Limiar de grayscale: pixel < CONTENT_THRESHOLD conta como conteúdo (não-branco).
CONTENT_THRESHOLD = 220
# Mínimo de caracteres alfanuméricos numa página de PDF para considerá-la "nativa"
# (com camada de texto). Abaixo disso, a página é tratada como escaneada → OCR.
MIN_PAGE_ALNUM = 20

_ROTATIONS = {
    0: None,
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

_reader = easyocr.Reader(LANGS, gpu=False)

app = FastAPI(title="DMDoc Extractor", version="1.0.0")


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


def _resize(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    scale = min(MAX_DIM / max(h, w), 1.0)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    return img


def _ocr_once(img: np.ndarray) -> tuple[list[str], list[float], float]:
    result = _reader.readtext(img, detail=1, paragraph=False)
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


def ocr_image(img: np.ndarray) -> str:
    """OCR completo: recorta branco, reescala, testa 4 rotações e escolhe a de
    texto mais coerente (maior soma de len*confiança)."""
    img = _resize(_crop_white(img))
    best: tuple[list[str], float] | None = None
    for code in _ROTATIONS.values():
        rotated = img if code is None else cv2.rotate(img, code)
        lines, _confs, score = _ocr_once(rotated)
        if best is None or score > best[1]:
            best = (lines, score)
    return "\n".join(best[0]) if best else ""


# ──────────────────────────── extração por formato ────────────────────────────


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
                    (".png", ".jpg", ".jpeg")
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


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    content_type: str = Form(default=""),
) -> dict:
    data = await file.read()
    mime = content_type or file.content_type or ""
    name = (file.filename or "").lower()

    if mime == "application/pdf" or name.endswith(".pdf"):
        out = extract_pdf(data)
    elif mime in ("image/jpeg", "image/png") or name.endswith((".jpg", ".jpeg", ".png")):
        out = extract_image(data)
    elif "wordprocessingml" in mime or name.endswith(".docx"):
        out = extract_docx(data)
    elif "spreadsheetml" in mime or name.endswith(".xlsx"):
        out = extract_xlsx(data)
    elif "presentationml" in mime or name.endswith(".pptx"):
        out = extract_pptx(data)
    else:
        out = {"text": "", "pageCount": 1, "ocrPages": [], "error": f"unsupported mime: {mime}"}

    out["engine"] = "python"
    return out
