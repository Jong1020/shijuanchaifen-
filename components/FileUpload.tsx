import React, { useCallback } from 'react';
import { UploadCloud, FileText, FileType } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, isProcessing }) => {
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (isProcessing) return;
      
      const file = e.dataTransfer.files[0];
      if (file && (file.type === 'application/pdf' || file.name.endsWith('.docx') || file.type === 'text/plain')) {
        onFileSelect(file);
      } else {
        alert('请上传 PDF 或 Word 文档。');
      }
    },
    [onFileSelect, isProcessing]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileSelect(e.target.files[0]);
      // Clear value to allow selecting the same file again if needed
      e.target.value = '';
    }
  };

  return (
    <div 
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className={`relative w-full max-w-2xl mx-auto h-64 rounded-2xl border-2 border-dashed transition-all duration-300 ease-in-out flex flex-col items-center justify-center text-center p-8
        ${isProcessing 
          ? 'border-indigo-200 bg-indigo-50/50 cursor-wait' 
          : 'border-slate-300 hover:border-indigo-500 hover:bg-indigo-50/30 cursor-pointer bg-white'
        }`}
    >
      <input 
        type="file" 
        accept=".pdf,.docx,.txt" 
        onChange={handleChange} 
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        disabled={isProcessing}
      />
      
      {isProcessing ? (
        <div className="flex flex-col items-center animate-pulse">
          <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
          <p className="text-lg font-medium text-indigo-900">正在处理文档...</p>
          <p className="text-sm text-indigo-600 mt-2">文本提取与智能题目识别中</p>
        </div>
      ) : (
        <>
          <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mb-4 shadow-sm">
            <UploadCloud size={32} />
          </div>
          <h3 className="text-xl font-semibold text-slate-800 mb-2">
            点击上传或拖拽文件至此
          </h3>
          <p className="text-slate-500 max-w-xs mx-auto mb-6">
            支持 PDF, Word (DOCX) 或文本文件。我们将为您自动智能拆分题目。
          </p>
          <div className="flex gap-4 text-xs text-slate-400 font-medium uppercase tracking-wide">
            <span className="flex items-center"><FileType size={14} className="mr-1"/> PDF</span>
            <span className="flex items-center"><FileText size={14} className="mr-1"/> DOCX</span>
          </div>
        </>
      )}
    </div>
  );
};