import React, { useState, useRef, useCallback } from 'react';
import { FileUpload } from './components/FileUpload';
import { QuestionCard } from './components/QuestionCard';
import { ManualCropper, ManualCropperRef } from './components/ManualCropper';
import { QuestionSegment, ProcessingState } from './types';
import { parseFile, PageImage } from './services/parser';
import { Sparkles, FileText, ChevronLeft, Layers, Crop, CheckSquare, Download, X, ScanLine, Image as ImageIcon, MousePointerClick, HelpCircle, Hand, MousePointer2, ZoomIn, ZoomOut, Maximize, Plus, Check, Keyboard } from 'lucide-react';
import html2canvas from 'html2canvas';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// DnD Kit Imports
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Sortable Item Wrapper
interface SortableItemProps {
  id: string;
  children: (dragProps: any) => React.ReactNode;
}

const SortableQuestionItem: React.FC<SortableItemProps> = ({ id, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
    opacity: isDragging ? 0.3 : 1, // Dim the original item while dragging
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className="touch-none"> 
      {children({ ...attributes, ...listeners })}
    </div>
  );
};

const App: React.FC = () => {
  const [questions, setQuestions] = useState<QuestionSegment[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [pageImages, setPageImages] = useState<PageImage[]>([]);
  const [isManualCropping, setIsManualCropping] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  // Cropper Lifted State
  const [cropperTool, setCropperTool] = useState<'select' | 'pan'>('select');
  const [cropperZoom, setCropperZoom] = useState(1);
  const [cropperHasSelection, setCropperHasSelection] = useState(false);
  const cropperRef = useRef<ManualCropperRef>(null);

  // Drag State
  const [activeId, setActiveId] = useState<string | null>(null);

  // Edit & Batch State
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isExportingBatch, setIsExportingBatch] = useState(false);
  
  const [processingState, setProcessingState] = useState<ProcessingState>({
    status: 'idle',
    message: '',
    progress: 0
  });

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), // Prevent drag on simple click
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      setQuestions((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over?.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
    setActiveId(null);
  };

  const cropImage = (
    base64Image: string, 
    xmin: number, 
    ymin: number, 
    xmax: number, 
    ymax: number, 
    originalWidth: number, 
    originalHeight: number
  ): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        
        // Pixel-perfect coordinate rounding to avoid sub-pixel blurring
        const xStart = Math.round((xmin / 1000) * originalWidth);
        const xEnd = Math.round((xmax / 1000) * originalWidth);
        const yStart = Math.round((ymin / 1000) * originalHeight);
        const yEnd = Math.round((ymax / 1000) * originalHeight);
        
        const width = xEnd - xStart;
        const height = yEnd - yStart;

        if (width <= 0 || height <= 0) {
            resolve(base64Image); 
            return;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Draw exact pixels
          ctx.drawImage(img, xStart, yStart, width, height, 0, 0, width, height);
          resolve(canvas.toDataURL('image/png'));
        } else {
          resolve(base64Image);
        }
      };
      img.onerror = () => resolve(base64Image);
      img.src = base64Image;
    });
  };

  const handleFileSelect = async (file: File) => {
    setFileName(file.name);
    setProcessingState({ status: 'parsing', message: '正在解析文件...', progress: 10 });
    setQuestions([]);
    setPageImages([]);
    // Reset batch & edit state
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setEditingQuestionId(null);

    try {
      const parseResult = await parseFile(file);
      const titleName = file.name.replace(/\.[^/.]+$/, "");
      
      const titleQuestion: QuestionSegment = {
        id: `title-${Date.now()}`,
        content: `<div style="text-align: center; font-weight: bold; font-size: 28px; line-height: 1.4; color: #1e293b; padding: 20px 10px;">${titleName}</div>`,
        type: 'text',
        isImage: false
      };

      const finalQuestions = [titleQuestion];

      if (Array.isArray(parseResult)) {
        // PDF Visual Flow
        setPageImages(parseResult);
        setQuestions(finalQuestions);
        setProcessingState({ status: 'complete', message: '解析完成', progress: 100 });
        
        // Automatically open manual cropper for PDF
        setIsManualCropping(true);

      } else {
        // Text/Docx Flow
        setProcessingState({ status: 'analyzing', message: '正在加载文本...', progress: 90 });
        
        // For Word/Txt, we just add one large block containing the full text
        const contentQuestion: QuestionSegment = {
            id: `body-${Date.now()}`,
            content: parseResult, // Full HTML/Text
            type: 'other',
            isImage: false
        };
        finalQuestions.push(contentQuestion);
        
        setQuestions(finalQuestions);
        setProcessingState({ status: 'complete', message: '完成！', progress: 100 });
      }
      
    } catch (error: any) {
      console.error(error);
      setProcessingState({ 
        status: 'error', 
        message: error.message || '发生了意外错误。', 
        progress: 0 
      });
    }
  };

  const handleDeleteQuestion = (id: string) => {
    setQuestions(prev => prev.filter(q => q.id !== id));
    setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
    });
  };

  const handleEditQuestion = (id: string) => {
    const question = questions.find(q => q.id === id);
    if (question && question.isImage && question.pageIndex !== undefined) {
        setEditingQuestionId(id);
        setIsManualCropping(true);
    }
  };

  const handleManualCropConfirm = useCallback(async (pageIndex: number, rect: { xmin: number; ymin: number; xmax: number; ymax: number }) => {
    const page = pageImages[pageIndex];
    if (!page) return;

    try {
      const croppedDataUrl = await cropImage(
        page.imageData, 
        rect.xmin, 
        rect.ymin, 
        rect.xmax, 
        rect.ymax, 
        page.width, 
        page.height
      );

      if (editingQuestionId) {
        // Update existing question
        setQuestions(prev => prev.map(q => {
            if (q.id === editingQuestionId) {
                return {
                    ...q,
                    content: croppedDataUrl,
                    pageIndex: page.pageIndex,
                    rect: rect // Update rect
                };
            }
            return q;
        }));
        setEditingQuestionId(null);
        setIsManualCropping(false); // Close on edit
      } else {
        // Add new question
        const newQuestion: QuestionSegment = {
            id: `manual-${Date.now()}`,
            content: croppedDataUrl,
            type: 'other',
            isImage: true,
            pageIndex: page.pageIndex,
            rect: rect // Store rect
        };
        setQuestions(prev => [...prev, newQuestion]);
        // DO NOT close on add, allowing continuous cropping
      }

    } catch (error) {
      console.error("Manual crop failed", error);
    }
  }, [editingQuestionId, pageImages]);

  const handleCloseCropper = useCallback(() => {
    setIsManualCropping(false);
    setEditingQuestionId(null);
  }, []);

  const reset = () => {
    setQuestions([]);
    setFileName('');
    setPageImages([]);
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setEditingQuestionId(null);
    setProcessingState({ status: 'idle', message: '', progress: 0 });
  };

  // Batch Selection Logic
  const toggleBatchMode = () => {
    setIsBatchMode(!isBatchMode);
    setSelectedIds(new Set());
    // Also cancel editing if active
    setEditingQuestionId(null);
    if (isManualCropping) setIsManualCropping(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === questions.length) {
        setSelectedIds(new Set());
    } else {
        setSelectedIds(new Set(questions.map(q => q.id)));
    }
  };

  // Generate a blob for a specific question, handling both Image and Text types
  const generateQuestionBlob = async (q: QuestionSegment): Promise<Blob | null> => {
     if (q.isImage) {
        try {
            const res = await fetch(q.content);
            return await res.blob();
        } catch (e) {
            console.error("Failed to fetch image content", e);
            return null;
        }
     } else {
        const elementId = `card-${q.id}`;
        const element = document.getElementById(elementId);
        if (!element) return null;

        const elementWidth = element.offsetWidth;
        const targetWidth = 3840; 
        const scale = Math.min(targetWidth / elementWidth, 4);

        element.classList.add('exporting');
        try {
            const canvas = await html2canvas(element, {
                scale: scale,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                allowTaint: true,
                ignoreElements: (el) => el.getAttribute('data-html2canvas-ignore') === 'true'
            });
            return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        } finally {
            element.classList.remove('exporting');
        }
     }
  };

  const handleBatchExport = async () => {
    if (selectedIds.size === 0) return;
    setIsExportingBatch(true);
    
    try {
        const zip = new JSZip();
        let count = 0;
        
        // Loop through all questions to maintain order
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (!selectedIds.has(q.id)) continue;

            const blob = await generateQuestionBlob(q);
            if (blob) {
                // Name files sequentially in the zip
                const filename = `题目_${i + 1}.png`;
                zip.file(filename, blob);
                count++;
            }
        }

        if (count === 0) {
            alert("未能生成有效图片，请重试。");
            return;
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const baseName = fileName.replace(/\.[^/.]+$/, "") || "文档导出";
        const zipFilename = `${baseName}_${dateStr}.zip`;

        const content = await zip.generateAsync({ type: "blob" });

        try {
            // @ts-ignore
            if (window.showSaveFilePicker) {
                // @ts-ignore
                const handle = await window.showSaveFilePicker({
                    suggestedName: zipFilename,
                    types: [{
                        description: 'ZIP Archive',
                        accept: { 'application/zip': ['.zip'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(content);
                await writable.close();
            } else {
                saveAs(content, zipFilename);
            }
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                saveAs(content, zipFilename);
            }
        }
        
        setIsBatchMode(false);
        setSelectedIds(new Set());
        
    } catch (error) {
        console.error("Batch export failed", error);
        alert("批量导出失败，请重试。");
    } finally {
        setIsExportingBatch(false);
    }
  };

  // Determine initial page index for cropper
  const getInitialPageIndex = () => {
      if (editingQuestionId) {
          const q = questions.find(q => q.id === editingQuestionId);
          if (q && q.pageIndex !== undefined) {
            const index = pageImages.findIndex(p => p.pageIndex === q.pageIndex);
            return index >= 0 ? index : 0;
          }
      }
      return 0; // Default for new manual crop
  };

  const getInitialRect = () => {
      if (editingQuestionId) {
          const q = questions.find(q => q.id === editingQuestionId);
          return q?.rect;
      }
      return undefined;
  }

  const activeQuestion = activeId ? questions.find(q => q.id === activeId) : null;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-indigo-50 text-slate-800 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/70 backdrop-blur-md pt-4 pb-2 border-b border-slate-200/50">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer group" onClick={reset}>
            <div className="bg-gradient-to-br from-indigo-500 to-indigo-600 p-2 rounded-lg text-white shadow-md shadow-indigo-200 transition-transform group-hover:scale-105">
              <Sparkles size={18} />
            </div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight hidden sm:block">
              SmartDoc <span className="text-indigo-600 font-normal opacity-80">| 试卷拆分</span>
            </h1>
          </div>
          
          <div className="flex items-center space-x-3">
             {questions.length > 0 && (
                <div className="flex items-center space-x-3 animate-fade-in-up">
                    
                    {/* Integrated Manual Cropper Toolbar - Visible only when cropping */}
                    {isManualCropping && (
                        <>
                             {/* Tools Segmented Control */}
                            <div className="flex bg-slate-100/80 backdrop-blur-sm rounded-lg p-1 mr-3 border border-slate-200 shadow-inner">
                                <button 
                                    onClick={() => setCropperTool('select')} 
                                    className={`p-1.5 rounded-md transition-all flex items-center space-x-1 ${cropperTool === 'select' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                                    title="选择模式"
                                >
                                    <MousePointer2 size={18} />
                                </button>
                                <button 
                                    onClick={() => setCropperTool('pan')} 
                                    className={`p-1.5 rounded-md transition-all flex items-center space-x-1 ${cropperTool === 'pan' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                                    title="拖拽模式 (空格键)"
                                >
                                    <Hand size={18} />
                                </button>
                            </div>

                            {/* Zoom Control Group */}
                            <div className="flex items-center bg-slate-100/80 backdrop-blur-sm rounded-lg p-1 mr-4 border border-slate-200 shadow-inner">
                                <button onClick={() => setCropperZoom(z => Math.max(0.1, z - 0.25))} className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded-md transition-all" title="缩小">
                                    <ZoomOut size={18} />
                                </button>
                                <div className="px-2 min-w-[3rem] text-center font-mono text-xs font-bold text-slate-600 select-none">
                                    {Math.round(cropperZoom * 100)}%
                                </div>
                                <button onClick={() => setCropperZoom(z => Math.min(10, z + 0.25))} className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded-md transition-all" title="放大">
                                    <ZoomIn size={18} />
                                </button>
                                <div className="w-px h-4 bg-slate-300 mx-1"></div>
                                <button onClick={() => setCropperZoom(1)} className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded-md transition-all" title="适应屏幕">
                                    <Maximize size={16} />
                                </button>
                            </div>

                             {/* Action Buttons */}
                             <div className="flex items-center space-x-2">
                                <button
                                    onClick={() => cropperRef.current?.confirm()}
                                    disabled={!cropperHasSelection}
                                    className={`flex items-center justify-center px-4 py-2 rounded-lg font-bold text-sm shadow-md transition-all duration-200 border
                                        ${cropperHasSelection 
                                        ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white hover:shadow-indigo-200/50 hover:scale-[1.02] border-transparent' 
                                        : 'bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200'}`}
                                >
                                    {editingQuestionId ? (
                                        <>
                                            <Check size={16} className="mr-2" />
                                            确认修改
                                        </>
                                    ) : (
                                        <>
                                            <Plus size={16} className="mr-2" />
                                            添加题目
                                        </>
                                    )}
                                </button>
                                
                                <button 
                                    onClick={() => {
                                        if (isManualCropping) {
                                            handleCloseCropper();
                                        }
                                    }}
                                    className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors border border-transparent hover:border-slate-200"
                                    title="退出拆题"
                                >
                                    <X size={20} />
                                </button>
                             </div>
                        </>
                    )}

                    {isBatchMode ? (
                        <>
                            <span className="text-sm font-medium text-slate-500 hidden md:inline mr-2">
                                已选择 {selectedIds.size} 项
                            </span>
                            <button 
                                onClick={toggleSelectAll}
                                className="px-4 py-2 text-sm font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 hover:shadow-sm rounded-lg transition-all border border-indigo-200"
                            >
                                {selectedIds.size === questions.length ? '取消全选' : '全选所有'}
                            </button>
                            <button 
                                onClick={handleBatchExport}
                                disabled={selectedIds.size === 0 || isExportingBatch}
                                className="flex items-center px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-full transition-all shadow-md shadow-indigo-200 hover:shadow-lg disabled:opacity-50 disabled:shadow-none"
                            >
                                {isExportingBatch ? (
                                    <span className="animate-pulse">打包中...</span>
                                ) : (
                                    <>
                                        <Download size={16} className="mr-2" />
                                        导出压缩包
                                    </>
                                )}
                            </button>
                            <button 
                                onClick={toggleBatchMode}
                                disabled={isExportingBatch}
                                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 rounded-full transition-colors"
                            >
                                <X size={20} />
                            </button>
                        </>
                    ) : (
                        <>
                             {/* Standard Actions */}
                             {pageImages.length > 0 && !isManualCropping && (
                                <div className="flex items-center space-x-2">
                                  <button 
                                    onClick={() => { 
                                        setEditingQuestionId(null); 
                                        setIsManualCropping(true); 
                                    }}
                                    className="hidden sm:flex items-center px-4 py-2 text-sm font-medium rounded-full transition-all border shadow-sm bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600 hover:shadow-md"
                                  >
                                    <Crop size={16} className="mr-2" />
                                    继续拆题
                                  </button>
                                  
                                  <button 
                                      onClick={toggleBatchMode}
                                      className="flex items-center px-4 py-2 text-sm font-medium text-slate-600 bg-white hover:bg-white hover:shadow-md rounded-full transition-all border border-slate-200/60 shadow-sm"
                                  >
                                      <CheckSquare size={16} className="mr-2" />
                                      批量导出
                                  </button>
                                  
                                  <button 
                                    onClick={reset}
                                    className="flex items-center px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 rounded-full transition-colors"
                                  >
                                    <ChevronLeft size={16} className="mr-1" />
                                    <span className="hidden sm:inline">新任务</span>
                                  </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
             )}
             
             {/* Help Button */}
             <button 
                onClick={() => setShowHelp(true)}
                className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors"
                title="使用说明"
             >
                <HelpCircle size={20} />
             </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col p-6">
        <div className="w-full max-w-5xl mx-auto flex-grow flex flex-col">
          
          {questions.length === 0 && (
            <div className="flex-grow flex flex-col items-center py-12">
              
              {/* Hero Section */}
              <div className="text-center mb-10 space-y-4 max-w-2xl animate-fade-in-up">
                 <h2 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight leading-tight">
                   高清试卷题目拆分
                 </h2>
                 <p className="text-lg text-slate-500 font-medium leading-relaxed">
                   导入 PDF 试卷或文档，手动精准框选题目区域，<br className="hidden sm:block"/>一键导出 8K 高清透明图片。
                 </p>
              </div>

              {/* Upload Component */}
              <div className="w-full max-w-2xl mb-16 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
                <FileUpload 
                    onFileSelect={handleFileSelect} 
                    isProcessing={processingState.status === 'parsing' || processingState.status === 'analyzing'} 
                />
                
                {/* Processing Indicators */}
                {processingState.status !== 'idle' && processingState.status !== 'complete' && (
                  <div className="mt-6 space-y-3">
                     <div className="flex justify-between text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                       <span>{processingState.message}</span>
                       <span>{processingState.progress}%</span>
                     </div>
                     <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                       <div 
                         className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 transition-all duration-300 ease-out rounded-full"
                         style={{ width: `${processingState.progress}%` }}
                       ></div>
                     </div>
                  </div>
                )}
                
                {processingState.status === 'error' && (
                  <div className="mt-6 p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl text-center text-sm font-medium">
                    {processingState.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {questions.length > 0 && (
            <div className="animate-fade-in-up">
              {!isManualCropping && (
                <div className="flex items-center justify-between mb-8 mt-4 px-2">
                    <div className="flex items-center space-x-4">
                    <div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-100 text-indigo-600">
                        <FileText size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-slate-800">{fileName}</h2>
                        <p className="text-sm font-medium text-slate-500 mt-0.5">
                            {isBatchMode ? '请选择要导出的题目' : '预览结果'}
                        </p>
                    </div>
                    </div>
                    
                    <div className="flex items-center space-x-2 text-sm font-bold text-slate-500 bg-white px-4 py-2 rounded-full border border-slate-100 shadow-sm">
                    <Layers size={14} />
                    <span>{questions.length} 题</span>
                    </div>
                </div>
              )}

              {/* Removed ManualCropper from here - Moved to root level below */}

              <DndContext 
                sensors={sensors} 
                collisionDetection={closestCenter} 
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext 
                    items={questions.map(q => q.id)} 
                    strategy={verticalListSortingStrategy}
                >
                    <div className={`space-y-8 ${isManualCropping ? 'hidden' : ''}`}>
                        {questions.map((q, index) => (
                        <SortableQuestionItem key={q.id} id={q.id}>
                            {(dragProps) => (
                                <QuestionCard 
                                    question={q} 
                                    index={index} 
                                    onDelete={handleDeleteQuestion}
                                    onEdit={handleEditQuestion}
                                    isSelectionMode={isBatchMode}
                                    isSelected={selectedIds.has(q.id)}
                                    onToggleSelect={toggleSelect}
                                    dragHandleProps={!isBatchMode ? dragProps : undefined}
                                />
                            )}
                        </SortableQuestionItem>
                        ))}
                    </div>
                </SortableContext>

                {/* Drag Overlay for smooth visual feedback */}
                <DragOverlay>
                  {activeQuestion ? (
                    <QuestionCard 
                        question={activeQuestion} 
                        index={questions.findIndex(q => q.id === activeId)} 
                        isSelectionMode={isBatchMode}
                        // Render without interactive buttons for drag preview, but preserve look
                    />
                  ) : null}
                </DragOverlay>

              </DndContext>

              {/* Show hint only if very few questions (just title) and not cropping */}
              {questions.length <= 1 && !isManualCropping && pageImages.length > 0 && (
                 <div className="mt-8 text-center animate-pulse">
                    <p className="text-indigo-600 font-medium">请点击右上角“手动拆题”开始添加题目</p>
                 </div>
              )}

              <div className="mt-16 text-center text-slate-400 text-sm font-medium pb-10">
                <p>SmartDoc 工具</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ManualCropper moved to Root Level to avoid 'fixed' positioning issues within 'transform' parents */}
      {isManualCropping && (
        <ManualCropper 
            ref={cropperRef}
            pageImages={pageImages}
            onClose={handleCloseCropper}
            onConfirm={handleManualCropConfirm}
            initialPageIndex={getInitialPageIndex()}
            isEditing={!!editingQuestionId}
            initialRect={getInitialRect()}
            nextIndex={questions.length + 1}
            // Lifted State
            tool={cropperTool}
            setTool={setCropperTool}
            zoom={cropperZoom}
            setZoom={setCropperZoom}
            onSelectionChange={setCropperHasSelection}
        />
      )}

      {/* Footer */}
      <footer className="py-6 text-center text-slate-400 text-sm font-medium">
         Created by Jong | Organization: Yunnan Normal University Affiliated Songming Middle School
      </footer>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full p-8 md:p-12 relative animate-fade-in-up overflow-hidden">
                {/* Background decoration */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                <button 
                    onClick={() => setShowHelp(false)}
                    className="absolute top-6 right-6 p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors z-10"
                >
                    <X size={24} />
                </button>
                
                <div className="text-center mb-12 relative z-10">
                    <h2 className="text-3xl font-extrabold text-slate-900 mb-3">快速上手指南</h2>
                    <p className="text-slate-500 text-lg">三步轻松拆解试卷，还原 8K 高清画质</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-12 relative z-10">
                    {/* Step 1 */}
                    <div className="group p-6 rounded-2xl bg-slate-50 hover:bg-white hover:shadow-xl transition-all duration-300 border border-slate-100 hover:border-indigo-100">
                        <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform">
                            <ScanLine size={28} />
                        </div>
                        <h3 className="font-bold text-xl text-slate-800 mb-3">1. 导入试卷</h3>
                        <p className="text-slate-500 leading-relaxed text-sm">
                            推荐上传 <b>PDF</b> 格式试卷以获得最佳清晰度。系统自动将文档渲染为高清图像底板，准备拆分。
                        </p>
                    </div>

                    {/* Step 2 */}
                    <div className="group p-6 rounded-2xl bg-slate-50 hover:bg-white hover:shadow-xl transition-all duration-300 border border-slate-100 hover:border-indigo-100">
                        <div className="w-14 h-14 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform">
                            <Crop size={28} />
                        </div>
                        <h3 className="font-bold text-xl text-slate-800 mb-3">2. 框选题目</h3>
                        <p className="text-slate-500 leading-relaxed text-sm">
                            进入拆题模式，鼠标拖拽框选题目。支持<b>快捷键</b>操作，效率倍增。无损裁剪，所见即所得。
                        </p>
                    </div>

                    {/* Step 3 */}
                    <div className="group p-6 rounded-2xl bg-slate-50 hover:bg-white hover:shadow-xl transition-all duration-300 border border-slate-100 hover:border-indigo-100">
                        <div className="w-14 h-14 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform">
                            <Download size={28} />
                        </div>
                        <h3 className="font-bold text-xl text-slate-800 mb-3">3. 导出/组卷</h3>
                        <p className="text-slate-500 leading-relaxed text-sm">
                            支持单题导出或<b>批量打包</b>下载 ZIP。导出图片为透明背景 PNG，方便粘贴到 Word 或 PPT 中使用。
                        </p>
                    </div>
                </div>

                {/* Shortcuts Section */}
                <div className="bg-slate-900 text-slate-300 rounded-xl p-6 relative overflow-hidden">
                    <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                        <div className="flex items-center gap-3">
                             <div className="p-2 bg-white/10 rounded-lg">
                                <Keyboard size={24} className="text-white" />
                             </div>
                             <div>
                                <h4 className="font-bold text-white">效率快捷键</h4>
                                <p className="text-xs text-slate-400">仅在拆题模式下有效</p>
                             </div>
                        </div>
                        
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full md:w-auto">
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">确认添加</span>
                                <kbd className="bg-white/10 px-2 py-1 rounded text-center font-mono font-bold text-white border-b-2 border-white/20">Enter</kbd>
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">切换抓手</span>
                                <kbd className="bg-white/10 px-2 py-1 rounded text-center font-mono font-bold text-white border-b-2 border-white/20">Space</kbd>
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">翻页</span>
                                <div className="flex gap-1">
                                    <kbd className="bg-white/10 px-2 py-1 rounded text-center font-mono font-bold text-white border-b-2 border-white/20 flex-1">←</kbd>
                                    <kbd className="bg-white/10 px-2 py-1 rounded text-center font-mono font-bold text-white border-b-2 border-white/20 flex-1">In</kbd>
                                </div>
                            </div>
                             <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">退出</span>
                                <kbd className="bg-white/10 px-2 py-1 rounded text-center font-mono font-bold text-white border-b-2 border-white/20">Esc</kbd>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div className="mt-10 text-center">
                     <button 
                        onClick={() => setShowHelp(false)}
                        className="px-10 py-3.5 bg-indigo-600 text-white font-bold text-lg rounded-xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 hover:shadow-indigo-300 hover:-translate-y-1 active:translate-y-0"
                    >
                        开始拆题
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

export default App;