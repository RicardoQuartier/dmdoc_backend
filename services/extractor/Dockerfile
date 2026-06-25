# Microserviço de extração de texto (Python) do DMDoc.
# Imagem CPU. Os modelos de OCR (EasyOCR) são baixados no build (camada cacheada)
# para a primeira requisição não pagar o download.
FROM python:3.10-slim

# Dependências nativas do OpenCV/PyMuPDF (libGL, glib) + LibreOffice para conversão Office→PDF.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libreoffice-impress \
    libreoffice-writer \
    libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala torch CPU primeiro (evita puxar o wheel CUDA, que é enorme).
RUN pip install --no-cache-dir torch==2.2.2 torchvision==0.17.2 \
    --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Pré-baixa os modelos de OCR (detecção + reconhecimento) para os idiomas configurados.
ARG OCR_LANGS=pt
ENV OCR_LANGS=${OCR_LANGS}
RUN python -c "import easyocr; easyocr.Reader('${OCR_LANGS}'.split(','), gpu=False)"

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "5"]
