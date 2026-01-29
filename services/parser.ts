import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@5.4.530/build/pdf.worker.min.mjs`;

export interface PageImage {
  pageIndex: number;
  imageData: string; // Base64 data URL
  width: number;
  height: number;
}

export const parseFile = async (file: File): Promise<string | PageImage[]> => {
  const fileType = file.name.split('.').pop()?.toLowerCase();

  switch (fileType) {
    case 'pdf':
      return await parsePdfToImages(file);
    case 'docx':
      return await parseDocxToHtml(file);
    case 'txt':
      return await file.text();
    default:
      throw new Error('不支持的文件类型。请上传 .pdf, .docx 或 .txt 文件。');
  }
};

// Render PDF pages to images.
// Adjusted: Scale increased to 3.5 (approx 252 DPI) to ensure high clarity for text and export.
// While this increases memory usage slightly compared to 2.5, it is necessary for crisp text.
const parsePdfToImages = async (file: File): Promise<PageImage[]> => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const pages: PageImage[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      // Scale 3.5 provides high-definition text suitable for exams (approx 250+ DPI)
      const viewport = page.getViewport({ scale: 3.5 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      
      if (!context) continue;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: context, viewport: viewport }).promise;
      
      pages.push({
        pageIndex: i,
        // Use PNG for lossless text clarity
        imageData: canvas.toDataURL('image/png'),
        width: viewport.width,
        height: viewport.height
      });
    }

    return pages;
  } catch (error) {
    console.error("PDF Parsing Error:", error);
    throw new Error("PDF 解析失败。请确保文件未加密，或尝试重新上传。");
  }
};

// Convert DOCX to HTML to preserve basic formatting and images better than raw text.
const parseDocxToHtml = async (file: File): Promise<string> => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    return result.value;
  } catch (error) {
    console.error("DOCX Parsing Error:", error);
    throw new Error("Word 文档解析失败。");
  }
};