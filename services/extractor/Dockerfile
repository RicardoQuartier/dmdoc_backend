# Microserviço de extração de texto (Python) do DMDoc.
# OCR via Tesseract (CPU-friendly, sem PyTorch) — funciona bem em hardware antigo
# sem AVX2/FMA. Imagem significativamente menor que a versão EasyOCR (~1GB a menos).
FROM python:3.10-slim

# Dependências nativas do OpenCV/PyMuPDF (libGL, glib) + LibreOffice para conversão
# Office→PDF + Tesseract com pacote de idioma Português.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libreoffice-impress \
    libreoffice-writer \
    libreoffice-calc \
    tesseract-ocr \
    tesseract-ocr-por \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "5"]
