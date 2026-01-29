import React, { useRef, useState } from 'react';
import { QuestionSegment } from '../types';
import { Download, Copy, Check, Trash2, Crop, GripVertical } from 'lucide-react';
import html2canvas from 'html2canvas';
import { saveAs } from 'file-saver';

interface QuestionCardProps {
  question: QuestionSegment;
  index: number;
  onDelete?: (id: string) => void;
  onEdit?: (id: string) => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  dragHandleProps?: any; // Props from dnd-kit for the drag handle
}

const typeMap: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  text: '文本题',
  calculation: '计算题',
  other: '综合题'
};

export const QuestionCard: React.FC<QuestionCardProps> = ({ 
  question, 
  index, 
  onDelete, 
  onEdit,
  isSelectionMode, 
  isSelected, 
  onToggleSelect,
  dragHandleProps
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!question.isImage) {
        // Strip HTML tags for copying text
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = question.content;
        const text = tempDiv.textContent || tempDiv.innerText || "";
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    } else {
        alert("图片题目暂不支持复制文本");
    }
  };

  const exportTo8K = async () => {
    setIsExporting(true);

    try {
      let blob: Blob | null = null;
      
      if (question.isImage) {
        // Direct download for images - preserves exact crop quality, no UI elements
        const response = await fetch(question.content);
        blob = await response.blob();
      } else {
        // Text questions need rendering
        if (!cardRef.current) return;
        
        const elementWidth = cardRef.current.offsetWidth;
        const targetWidth = 3840; // 4K width is usually sufficient for text, keeping 8K logic if needed
        const scale = Math.min(targetWidth / elementWidth, 4);

        const canvas = await html2canvas(cardRef.current, {
          scale: scale, 
          backgroundColor: '#ffffff',
          useCORS: true,
          logging: false,
          allowTaint: true,
          // Explicitly ignore elements marked with this attribute
          ignoreElements: (element) => element.getAttribute('data-html2canvas-ignore') === 'true'
        });

        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1.0));
      }

      if (blob) {
        const filename = `题目_${index + 1}.png`;
        
        try {
            // @ts-ignore
            if (window.showSaveFilePicker) {
                // @ts-ignore
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'PNG Image',
                        accept: { 'image/png': ['.png'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } else {
                saveAs(blob, filename);
            }
        } catch (err: any) {
            // If user cancels or API fails, fallback to simple saveAs if not an abort error
            if (err.name !== 'AbortError') {
                saveAs(blob, filename);
            }
        }
      }
    } catch (err) {
      console.error("Export failed", err);
      alert("图片导出失败。");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div 
      className={`group relative w-full mb-6 perspective-1000 transition-transform duration-300 ${isSelectionMode ? 'cursor-pointer' : ''}`}
      onClick={() => isSelectionMode && onToggleSelect && onToggleSelect(question.id)}
    >
      {/* Drag Handle - only show when not in selection mode and handle props are provided */}
      {!isSelectionMode && dragHandleProps && (
        <div 
            className="absolute top-8 -left-10 p-2 cursor-grab active:cursor-grabbing text-slate-300 hover:text-indigo-500 hidden xl:flex items-center justify-center transition-colors"
            {...dragHandleProps}
            title="拖动调整顺序"
        >
            <GripVertical size={24} />
        </div>
      )}

      <div className={`absolute -inset-1 bg-gradient-to-r from-blue-100 to-indigo-100 rounded-2xl blur opacity-0 group-hover:opacity-50 transition duration-500 ${isSelected ? 'opacity-75 ring-2 ring-indigo-500' : ''}`}></div>
      
      <div 
        ref={cardRef}
        id={`card-${question.id}`}
        className={`relative bg-white rounded-xl shadow-sm border transition-all duration-300 hover:shadow-lg
          ${isSelected ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-slate-100'}
          ${question.isImage ? 'p-4' : 'p-8 md:p-10'}
        `}
      >
        {/* Header Metadata - Ignored during export */}
        <div 
          className="flex justify-between items-center mb-4 pb-2 border-b border-slate-50"
          data-html2canvas-ignore="true" 
        >
          <div className="flex items-center space-x-3">
             {/* Mobile Drag Handle (inside card) */}
             {!isSelectionMode && dragHandleProps && (
                <div className="xl:hidden text-slate-300 mr-1" {...dragHandleProps}>
                    <GripVertical size={18} />
                </div>
             )}

            {isSelectionMode ? (
              <div className={`flex items-center justify-center w-7 h-7 rounded-full border-2 transition-colors ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-200 bg-white'}`}>
                {isSelected && <Check size={14} className="text-white" />}
              </div>
            ) : (
              <span className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 text-slate-600 font-bold text-xs">
                {index + 1}
              </span>
            )}
            
            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400 bg-slate-50 px-2 py-0.5 rounded">
              {typeMap[question.type] || question.type}
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div className="prose prose-lg max-w-none prose-slate">
            {question.isImage ? (
                <div 
                    className={`w-full overflow-hidden rounded-md ${question.pageIndex !== undefined && onEdit && !isSelectionMode ? 'cursor-pointer hover:ring-2 hover:ring-indigo-100 transition-all' : ''}`}
                    onClick={(e) => {
                        if (question.pageIndex !== undefined && onEdit && !isSelectionMode) {
                            e.stopPropagation();
                            onEdit(question.id);
                        }
                    }}
                    title={question.pageIndex !== undefined && onEdit && !isSelectionMode ? "点击编辑裁剪区域" : ""}
                >
                    <img 
                        src={question.content} 
                        alt={`Question ${index + 1}`} 
                        className="w-full h-auto object-contain block" 
                        loading="lazy"
                    />
                </div>
            ) : (
                <>
                  {question.content.includes('<') ? (
                    <div 
                      className="font-serif text-slate-800 leading-relaxed whitespace-pre-wrap"
                      dangerouslySetInnerHTML={{ __html: question.content }}
                    />
                  ) : (
                    <div className="font-serif text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {question.content}
                    </div>
                  )}
                </>
            )}
        </div>
      </div>

      {/* Floating Action Bar - Hide in selection mode to prevent misclicks */}
      {!isSelectionMode && (
        <div 
          className="absolute top-2 right-2 flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10"
          data-html2canvas-ignore="true"
        >
          {question.isImage && question.pageIndex !== undefined && onEdit && (
            <button
                onClick={(e) => { e.stopPropagation(); onEdit(question.id); }}
                className="p-1.5 bg-white/90 backdrop-blur text-slate-500 rounded hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 shadow-sm transition-colors"
                title="重新裁剪"
            >
                <Crop size={16} />
            </button>
          )}

          {!question.isImage && (
              <button 
                onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                className="p-1.5 bg-white/90 backdrop-blur text-slate-500 rounded hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 shadow-sm transition-colors"
                title="复制文本"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); exportTo8K(); }}
            disabled={isExporting}
            className={`p-1.5 bg-white/90 backdrop-blur text-slate-500 rounded hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 shadow-sm transition-colors flex items-center space-x-1 ${isExporting ? 'animate-pulse' : ''}`}
            title="导出图片"
          >
            <Download size={16} />
          </button>
          {onDelete && (
            <button 
              onClick={(e) => { e.stopPropagation(); onDelete(question.id); }}
              className="p-1.5 bg-white/90 backdrop-blur text-slate-400 rounded hover:text-red-600 hover:bg-red-50 border border-slate-200 shadow-sm transition-colors"
              title="删除此题"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};