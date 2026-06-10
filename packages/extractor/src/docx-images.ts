import { readFile } from 'node:fs/promises';

async function importMammoth() {
  const mod = await import('mammoth');
  return mod as {
    convertToHtml: (
      opts: { buffer: Buffer },
      options: {
        convertImage: {
          __mammothBrand: 'ImageConverter';
        };
      }
    ) => Promise<{ value: string }>;
    images: {
      imgElement: (
        f: (image: {
          contentType: string;
          readAsBuffer: () => Promise<Buffer>;
        }) => Promise<{ src: string }>
      ) => { __mammothBrand: 'ImageConverter' };
    };
  };
}

async function importTesseract() {
  const mod = await import('tesseract.js');
  return mod as unknown as {
    createWorker: (lang: string) => Promise<{
      recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
      terminate: () => Promise<void>;
    }>;
  };
}

/**
 * Extrai e faz OCR em todas as imagens embutidas de um arquivo DOCX.
 * Retorna o texto OCR concatenado, ou string vazia se não houver imagens.
 */
export async function extractDocxImageText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const mammoth = await importMammoth();

  const capturedImages: Buffer[] = [];
  await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const imgBuffer = await image.readAsBuffer();
        capturedImages.push(imgBuffer);
        return { src: '' };
      }),
    }
  );

  if (capturedImages.length === 0) return '';

  const tesseract = await importTesseract();
  const worker = await tesseract.createWorker('por+eng');
  const ocrTexts: string[] = [];
  try {
    for (const imgBuffer of capturedImages) {
      const r = await worker.recognize(imgBuffer);
      const t = r.data.text.trim();
      if (t.length > 0) ocrTexts.push(t);
    }
  } finally {
    await worker.terminate();
  }

  return ocrTexts.join('\n\n');
}
