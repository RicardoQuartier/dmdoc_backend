"""Microserviço de OCR baseado em EasyOCR.

Recebe uma imagem (multipart 'file') e devolve o texto reconhecido. Usado pelo
worker do DMDoc como motor de OCR para scans/imagens onde o Unstructured falha
(documentos de identidade, certificados).

Por que EasyOCR e não um LLM multimodal: LLMs (gpt-4o) recusam transcrever
documentos de identidade por política de PII. EasyOCR é um motor de OCR dedicado —
não recusa nada e tem suporte nativo a português.

Auto-rotação: scans podem chegar girados (ex.: RG digitalizado de lado). Em vez de
confiar no `rotation_info` por bloco do EasyOCR (que embaralha a ordem de leitura e
perde campos grandes como o nome), rodamos o OCR na imagem inteira nos 4 ângulos e
escolhemos o de maior score — texto coerente produz palavras longas e confiantes.
"""

import os
import tempfile

import cv2
import numpy as np
import easyocr
from fastapi import FastAPI, File, UploadFile

# Idioma(s) do reconhecimento. 'pt' cobre os acentos do português.
LANGS = os.environ.get("OCR_LANGS", "pt").split(",")

# Mapa ângulo → código de rotação do OpenCV (None = sem rotação).
_ROTATIONS = {
    0: None,
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

# Instancia uma vez no boot (carrega os modelos de detecção + reconhecimento).
_reader = easyocr.Reader(LANGS, gpu=False)

app = FastAPI(title="DMDoc OCR (EasyOCR)", version="2.0.0")


def _run_ocr(image: np.ndarray) -> tuple[list[str], list[float], float]:
    """Roda o OCR numa imagem e devolve (linhas, confianças, score).

    Score = soma de len(texto)*confiança por bloco. Recompensa orientações que
    produzem texto longo e confiante (documento em pé) sobre fragmentos curtos
    (documento girado).
    """
    result = _reader.readtext(image, detail=1, paragraph=False)
    lines: list[str] = []
    confidences: list[float] = []
    score = 0.0
    for item in result or []:
        try:
            text = item[1].strip()
            conf = float(item[2])
        except (IndexError, TypeError, ValueError, AttributeError):
            continue
        if text:
            lines.append(text)
            confidences.append(conf)
            score += len(text) * conf
    return lines, confidences, score


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "langs": LANGS}


@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...), autorotate: bool = True) -> dict:
    data = await file.read()
    arr = np.frombuffer(data, np.uint8)
    img0 = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img0 is None:
        return {"text": "", "lineCount": 0, "avgConfidence": 0.0, "rotation": 0}

    if autorotate:
        best: tuple[list[str], list[float], float, int] | None = None
        for angle, code in _ROTATIONS.items():
            image = img0 if code is None else cv2.rotate(img0, code)
            lines, confs, score = _run_ocr(image)
            if best is None or score > best[2]:
                best = (lines, confs, score, angle)
        lines, confidences, _, rotation = best  # type: ignore[misc]
    else:
        lines, confidences, _ = _run_ocr(img0)
        rotation = 0

    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0
    return {
        "text": "\n".join(lines),
        "lineCount": len(lines),
        "avgConfidence": round(avg_conf, 4),
        "rotation": rotation,
    }
