import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { PageImage } from '../services/parser';
import { ChevronLeft, ChevronRight, ArrowDownRight, Check } from 'lucide-react';

export interface ManualCropperRef {
    confirm: () => void;
}

interface ManualCropperProps {
  pageImages: PageImage[];
  initialPageIndex?: number;
  onConfirm: (pageIndex: number, rect: { xmin: number; ymin: number; xmax: number; ymax: number }) => void;
  onClose: () => void;
  isEditing?: boolean;
  initialRect?: { xmin: number; ymin: number; xmax: number; ymax: number };
  nextIndex?: number;
  
  // Lifted State
  tool: 'select' | 'pan';
  setTool: (t: 'select' | 'pan') => void;
  zoom: number;
  setZoom: (z: number | ((prev: number) => number)) => void;
  onSelectionChange: (hasSelection: boolean) => void;
}

// Normalized coordinate type (0-1000)
interface NormalizedRect {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
}

// Interaction modes
type InteractionMode = 
  | 'none'
  | 'drawing' 
  | 'moving' 
  | 'resizing-n' 
  | 'resizing-s' 
  | 'resizing-e' 
  | 'resizing-w' 
  | 'resizing-nw' 
  | 'resizing-ne' 
  | 'resizing-sw' 
  | 'resizing-se';

export const ManualCropper = forwardRef<ManualCropperRef, ManualCropperProps>(({ 
  pageImages, 
  initialPageIndex = 0, 
  onConfirm, 
  onClose,
  isEditing = false,
  initialRect,
  nextIndex = 1,
  tool,
  setTool,
  zoom,
  setZoom,
  onSelectionChange
}, ref) => {
  const [currentPageIndex, setCurrentPageIndex] = useState(initialPageIndex);
  
  // Selection state
  const [selection, setSelection] = useState<NormalizedRect | null>(null);
  
  // View state
  const [fitScale, setFitScale] = useState(1);
  const [isLayoutReady, setIsLayoutReady] = useState(false);
  
  // Interaction state
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('none');
  
  // Feedback state
  const [showToast, setShowToast] = useState<{message: string, visible: boolean}>({ message: '', visible: false });

  // Refs for tracking drag deltas
  const dragStartPoint = useRef<{x: number, y: number} | null>(null);
  const initialSelectionRef = useRef<NormalizedRect | null>(null);
  const lastPanPosition = useRef<{x: number, y: number} | null>(null);
  
  // Improved Scroll Tracking: Store exact X/Y ratios
  const viewportCenter = useRef<{x: number, y: number} | null>(null);
  const preservedScrollRatio = useRef<{x: number, y: number} | null>(null);
  
  const scrollThrottle = useRef(false);
  const hasInitializedZoom = useRef(false);
  
  // Dual Canvas Refs
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);   // Static: Draws the PDF image
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null); // Dynamic: Draws selection & dimming
  
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null); // The interactive surface

  const currentPage = pageImages[currentPageIndex];

  // Notify parent about selection changes
  useEffect(() => {
    onSelectionChange(!!selection);
  }, [selection, onSelectionChange]);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    confirm: () => {
        handleConfirm();
    }
  }));

  // Helper to capture current horizontal scroll ratio (to preserve zoom center X)
  const getCurrentXRatio = () => {
      if (containerRef.current) {
          const { scrollLeft, scrollWidth, clientWidth } = containerRef.current;
          // Calculate center point ratio X
          return (scrollLeft + clientWidth / 2) / scrollWidth;
      }
      return 0.5;
  };

  // Calculate Layout Function
  const calculateLayout = useCallback((preserveView = false) => {
    if (!containerRef.current || !currentPage) return;
    
    const padding = 0; 
    const containerWidth = containerRef.current.clientWidth - padding;
    const containerHeight = containerRef.current.clientHeight - padding;
    
    if (containerWidth <= 0 || containerHeight <= 0) return;

    // Scale to fit within container (Default)
    const scaleX = containerWidth / currentPage.width;
    const scaleY = containerHeight / currentPage.height;
    
    if (isEditing && initialRect && !hasInitializedZoom.current) {
        // Feature: When editing, fit by width to maximize visibility
        // Only on first load of the edit session
        const fitWidthScale = containerWidth / currentPage.width;
        setFitScale(fitWidthScale);
        
        if (!preserveView) {
            setZoom(1);
            if (currentPageIndex === initialPageIndex) {
                setSelection(initialRect);
                // Center exactly on the selection
                const centerX = (initialRect.xmin + initialRect.xmax) / 2 / 1000;
                const centerY = (initialRect.ymin + initialRect.ymax) / 2 / 1000;
                viewportCenter.current = { x: centerX, y: centerY };
            }
        }
        hasInitializedZoom.current = true;
    } else {
        // Default mode
        const fitScreenScale = Math.min(scaleX, scaleY);
        setFitScale(fitScreenScale);

        if (!preserveView) {
            // Intelligent Default Zoom - ONLY on first load
            if (!hasInitializedZoom.current) {
                // If portrait image on landscape screen (scaleY < scaleX), default to fitting width
                if (scaleY < scaleX) {
                    const widthFitZoom = scaleX / scaleY;
                    const targetZoom = Math.min(widthFitZoom * 1.0, 3.0); 
                    setZoom(Math.max(targetZoom, 1.0));
                } else {
                    setZoom(1.0);
                }
                
                // Initial Center
                if (initialRect && currentPageIndex === initialPageIndex) {
                    setSelection(initialRect);
                    const centerX = (initialRect.xmin + initialRect.xmax) / 2 / 1000;
                    const centerY = (initialRect.ymin + initialRect.ymax) / 2 / 1000;
                    viewportCenter.current = { x: centerX, y: centerY };
                } else {
                    setSelection(null); 
                    viewportCenter.current = { x: 0.5, y: 0 }; 
                }
                setTool('select');
                hasInitializedZoom.current = true;
            } else {
                // Page transition logic
                setSelection(null);
                
                // If we possess a preserved scroll ratio from the previous page, use it.
                if (preservedScrollRatio.current) {
                    viewportCenter.current = preservedScrollRatio.current;
                    preservedScrollRatio.current = null;
                } else {
                    // Default fallback (Top of page)
                    viewportCenter.current = { x: 0.5, y: 0 };
                }
            }
        }
    }
    
    setIsLayoutReady(true);
  }, [currentPage, currentPageIndex, initialPageIndex, initialRect, isEditing, setZoom, setTool]);

  // Layout Effect: Resize Observer to handle first load and window resize
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial calculation attempt (reset view if first load)
    calculateLayout(false);

    const observer = new ResizeObserver(() => {
        // Re-calculate when container size changes (window resize or initial layout)
        requestAnimationFrame(() => {
            calculateLayout(true);
        });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [calculateLayout]);

  // Handle Zoom/Scroll Restoration
  useLayoutEffect(() => {
    if (isLayoutReady && viewportCenter.current && containerRef.current) {
        const { x, y } = viewportCenter.current;
        const { scrollWidth, scrollHeight, clientWidth, clientHeight } = containerRef.current;
        
        // Only scroll if dimensions are valid and content is larger than viewport
        if (scrollWidth > 0 && scrollHeight > 0) {
            const newScrollLeft = x * scrollWidth - clientWidth / 2;
            const newScrollTop = y * scrollHeight - clientHeight / 2;
            
            containerRef.current.scrollLeft = newScrollLeft;
            containerRef.current.scrollTop = newScrollTop;
            
            // Clear the target center after applying
            viewportCenter.current = null;
        }
    }
  }, [zoom, fitScale, isLayoutReady, currentPageIndex]); 

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space for Pan Toggle
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        // Toggle between select and pan
        setTool(tool === 'select' ? 'pan' : 'select');
      }
      
      // Arrows for Navigation
      if (document.activeElement?.tagName !== 'INPUT') {
          if (e.key === 'ArrowLeft') {
              // Prev Page: Preserve X, go to Top (Standard behavior) or Bottom?
              // User request: "Flip page -> Next page should be at Top".
              // For consistent simple navigation, let's reset to Top for arrow keys.
              preservedScrollRatio.current = { x: getCurrentXRatio(), y: 0 };
              setCurrentPageIndex(prev => Math.max(0, prev - 1));
          } else if (e.key === 'ArrowRight') {
              // Next Page: Preserve X, go to Top
              preservedScrollRatio.current = { x: getCurrentXRatio(), y: 0 };
              setCurrentPageIndex(prev => Math.min(pageImages.length - 1, prev + 1));
          } else if (e.key === 'Escape') {
              onClose();
          } else if (e.key === 'Enter') {
             // Enter to add/confirm
             if (selection) {
                 e.preventDefault();
                 handleConfirm();
             }
          }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pageImages.length, selection, onClose, tool, setTool]);

  // Scroll Navigation Logic
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Do nothing if holding control (likely zooming)
      if (e.ctrlKey) return;
      
      if (scrollThrottle.current) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      const isScrollable = scrollHeight > clientHeight;
      const delta = e.deltaY;
      
      const threshold = 10; // px buffer

      if (delta > 0) {
        // Scrolling Down
        const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < threshold;
        
        if (!isScrollable || isAtBottom) {
           if (currentPageIndex < pageImages.length - 1) {
               e.preventDefault();
               // Next Page -> Top
               preservedScrollRatio.current = { x: getCurrentXRatio(), y: 0 };
               setCurrentPageIndex(p => p + 1);
               
               scrollThrottle.current = true;
               setTimeout(() => scrollThrottle.current = false, 500); 
           }
        }
      } else if (delta < 0) {
        // Scrolling Up
        const isAtTop = scrollTop < threshold;
        
        if (!isScrollable || isAtTop) {
           if (currentPageIndex > 0) {
               e.preventDefault();
               // Prev Page -> Bottom (Continuous Scroll feel)
               preservedScrollRatio.current = { x: getCurrentXRatio(), y: 1 };
               setCurrentPageIndex(p => p - 1);

               scrollThrottle.current = true;
               setTimeout(() => scrollThrottle.current = false, 500);
           }
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [currentPageIndex, pageImages.length]);


  const getNormalizedCoordinates = (e: React.PointerEvent) => {
    if (!imageCanvasRef.current) return { x: 0, y: 0 };
    const rect = imageCanvasRef.current.getBoundingClientRect();
    const visualX = e.clientX - rect.left;
    const visualY = e.clientY - rect.top;
    const internalX = visualX * (imageCanvasRef.current.width / rect.width);
    const internalY = visualY * (imageCanvasRef.current.height / rect.height);

    return {
      x: Math.max(0, Math.min(1000, (internalX / imageCanvasRef.current.width) * 1000)),
      y: Math.max(0, Math.min(1000, (internalY / imageCanvasRef.current.height) * 1000))
    };
  };

  // --- Pointer Handlers ---

  const startDragState = (e: React.PointerEvent, mode: InteractionMode) => {
    const { x, y } = getNormalizedCoordinates(e);
    dragStartPoint.current = { x, y };
    setInteractionMode(mode);
    if (selection) {
        initialSelectionRef.current = { ...selection };
    } else {
        // For new drawings, initialize to current point
        initialSelectionRef.current = { xmin: x, ymin: y, xmax: x, ymax: y };
        setSelection({ xmin: x, ymin: y, xmax: x, ymax: y });
    }
  };

  const handleHandleDown = (e: React.PointerEvent, mode: InteractionMode) => {
    if (tool === 'pan') return; 
    e.preventDefault();
    e.stopPropagation(); 
    if (wrapperRef.current) wrapperRef.current.setPointerCapture(e.pointerId);
    startDragState(e, mode);
  };

  const handleBoxDown = (e: React.PointerEvent) => {
    if (tool === 'pan') return; 
    e.preventDefault();
    e.stopPropagation(); 
    if (wrapperRef.current) wrapperRef.current.setPointerCapture(e.pointerId);
    startDragState(e, 'moving');
  };

  const handleBackgroundDown = (e: React.PointerEvent) => {
    if (tool === 'pan') {
        if (wrapperRef.current) wrapperRef.current.setPointerCapture(e.pointerId);
        setInteractionMode('moving'); // Re-use moving state for pan logic
        lastPanPosition.current = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
    }
    
    e.preventDefault();
    if (wrapperRef.current) wrapperRef.current.setPointerCapture(e.pointerId);
    startDragState(e, 'drawing');
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    // Handle Panning
    if (tool === 'pan') {
        if (interactionMode === 'moving' && lastPanPosition.current && containerRef.current) {
            e.preventDefault();
            const deltaX = e.clientX - lastPanPosition.current.x;
            const deltaY = e.clientY - lastPanPosition.current.y;
            containerRef.current.scrollLeft -= deltaX;
            containerRef.current.scrollTop -= deltaY;
            lastPanPosition.current = { x: e.clientX, y: e.clientY };
        }
        return;
    }

    if (interactionMode === 'none') return;
    if (!dragStartPoint.current || !initialSelectionRef.current) return;

    e.preventDefault();
    const { x, y } = getNormalizedCoordinates(e);
    const dx = x - dragStartPoint.current.x;
    const dy = y - dragStartPoint.current.y;
    const initial = initialSelectionRef.current;

    let newRect = { ...initial };

    if (interactionMode === 'moving') {
        const width = initial.xmax - initial.xmin;
        const height = initial.ymax - initial.ymin;
        
        let newX = initial.xmin + dx;
        let newY = initial.ymin + dy;

        if (newX < 0) newX = 0;
        if (newY < 0) newY = 0;
        if (newX + width > 1000) newX = 1000 - width;
        if (newY + height > 1000) newY = 1000 - height;

        newRect = {
            xmin: newX,
            ymin: newY,
            xmax: newX + width,
            ymax: newY + height
        };
    } else if (interactionMode === 'drawing') {
        newRect = {
            xmin: Math.min(initial.xmin, x),
            ymin: Math.min(initial.ymin, y),
            xmax: Math.max(initial.xmin, x),
            ymax: Math.max(initial.ymin, y)
        };
    } else {
        const isWest = interactionMode === 'resizing-w' || interactionMode === 'resizing-nw' || interactionMode === 'resizing-sw';
        const isEast = interactionMode === 'resizing-e' || interactionMode === 'resizing-ne' || interactionMode === 'resizing-se';
        const isNorth = interactionMode === 'resizing-n' || interactionMode === 'resizing-nw' || interactionMode === 'resizing-ne';
        const isSouth = interactionMode === 'resizing-s' || interactionMode === 'resizing-sw' || interactionMode === 'resizing-se';

        if (isWest) newRect.xmin = Math.min(initial.xmin + dx, initial.xmax - 10);
        if (isEast) newRect.xmax = Math.max(initial.xmax + dx, initial.xmin + 10);
        if (isNorth) newRect.ymin = Math.min(initial.ymin + dy, initial.ymax - 10);
        if (isSouth) newRect.ymax = Math.max(initial.ymax + dy, initial.ymin + 10);
    }
    
    setSelection(newRect);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (tool === 'pan') {
         lastPanPosition.current = null;
    }
    
    try {
        if (wrapperRef.current && wrapperRef.current.hasPointerCapture(e.pointerId)) {
             wrapperRef.current.releasePointerCapture(e.pointerId);
        }
    } catch {}

    if (interactionMode === 'drawing' && selection) {
        if (Math.abs(selection.xmax - selection.xmin) < 10 || Math.abs(selection.ymax - selection.ymin) < 10) {
            setSelection(null);
        }
    }

    setInteractionMode('none');
    dragStartPoint.current = null;
    initialSelectionRef.current = null;
  };

  const handleConfirm = () => {
    if (!selection) return;
    onConfirm(currentPageIndex, selection);
    
    if (!isEditing) {
        // Continuous mode logic
        setSelection(null); // Clear selection to allow next crop
        
        // Show success toast
        const msg = `第 ${nextIndex} 题 已添加`;
        setShowToast({ message: msg, visible: true });
        
        // Hide toast after 2s
        setTimeout(() => {
            setShowToast(prev => ({...prev, visible: false}));
        }, 1500);
    } else {
        // Edit mode - just clear
        setSelection(null);
    }
  };

  const getCursorForMode = (mode: InteractionMode) => {
    if (mode === 'moving') return 'move';
    if (mode === 'resizing-nw') return 'nw-resize';
    if (mode === 'resizing-ne') return 'ne-resize';
    if (mode === 'resizing-sw') return 'sw-resize';
    if (mode === 'resizing-se') return 'se-resize';
    if (mode === 'resizing-n') return 'n-resize';
    if (mode === 'resizing-s') return 's-resize';
    if (mode === 'resizing-w') return 'w-resize';
    if (mode === 'resizing-e') return 'e-resize';
    return 'default';
  };

  // LAYER 1: Draw Image (Static, Heavy)
  // Only redraws when the Page or Canvas dimensions change.
  useEffect(() => {
      const canvas = imageCanvasRef.current;
      if (!canvas || !currentPage) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      img.src = currentPage.imageData;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const draw = () => {
          canvas.width = currentPage.width;
          canvas.height = currentPage.height;
          ctx.drawImage(img, 0, 0);
      };

      img.onload = draw;
      if (img.complete) draw();
  }, [currentPage]);

  // LAYER 2: Draw Overlay (Dynamic, Light)
  // Redraws whenever selection changes. Fast.
  useEffect(() => {
      const canvas = overlayCanvasRef.current;
      if (!canvas || !currentPage) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Match dimensions to image canvas
      if (canvas.width !== currentPage.width || canvas.height !== currentPage.height) {
          canvas.width = currentPage.width;
          canvas.height = currentPage.height;
      }
      
      // Clear previous overlay frame
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (selection) {
          const x = (selection.xmin / 1000) * canvas.width;
          const y = (selection.ymin / 1000) * canvas.height;
          const w = ((selection.xmax - selection.xmin) / 1000) * canvas.width;
          const h = ((selection.ymax - selection.ymin) / 1000) * canvas.height;

          // Draw semi-transparent background
          ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          
          // Clear the "hole" for selection
          ctx.clearRect(x, y, w, h);
      }
  }, [currentPage, selection]);


  return (
    <div className="fixed inset-0 top-14 z-[40] bg-slate-900/60 backdrop-blur-md animate-fade-in text-white select-none">
      
      {/* 0. Toast Notification */}
      <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[80] pointer-events-none transition-all duration-300 ${showToast.visible ? 'opacity-100 scale-100' : 'opacity-0 scale-90'}`}>
         <div className="bg-slate-900/80 backdrop-blur-xl text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center space-x-3 border border-slate-700/50">
            <div className="bg-green-500 rounded-full p-1">
                <Check size={20} className="text-white" />
            </div>
            <span className="font-bold text-lg tracking-wide">{showToast.message}</span>
         </div>
      </div>

      {/* 1. Canvas Container - Fixed Layout */}
      <div 
        ref={containerRef}
        className="absolute inset-0 overflow-auto touch-none no-scrollbar flex"
      >
        <div 
            ref={wrapperRef}
            className={`m-auto shrink-0 relative shadow-2xl bg-white ${isLayoutReady ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            tabIndex={-1} 
            style={{
                width: currentPage ? currentPage.width * fitScale * zoom : 'auto',
                height: currentPage ? currentPage.height * fitScale * zoom : 'auto',
                cursor: tool === 'pan' 
                    ? (interactionMode === 'moving' ? 'grabbing' : 'grab') 
                    : (interactionMode === 'drawing' ? 'crosshair' : (interactionMode !== 'none' ? getCursorForMode(interactionMode) : 'default'))
            }}
        >
                {/* Layer 1: The Image (Z-Index 0) */}
                <canvas
                    ref={imageCanvasRef}
                    className="absolute inset-0 w-full h-full block"
                    style={{ zIndex: 0 }}
                />

                {/* Layer 2: The Overlay (Z-Index 10) */}
                <canvas
                    ref={overlayCanvasRef}
                    className="absolute inset-0 w-full h-full block pointer-events-none"
                    style={{ zIndex: 10 }}
                />

                {/* Interaction DOM Elements (Z-Index 20) */}
                <div 
                    className="absolute inset-0 touch-none"
                    onPointerDown={handleBackgroundDown}
                    style={{ cursor: tool === 'pan' ? 'grab' : 'crosshair', zIndex: 20 }}
                >
                    {selection && (
                        <div 
                            className="absolute pointer-events-none"
                            style={{ 
                                left: `${selection.xmin / 10}%`, 
                                top: `${selection.ymin / 10}%`,
                                width: `${(selection.xmax - selection.xmin) / 10}%`,
                                height: `${(selection.ymax - selection.ymin) / 10}%`
                            }}
                        >
                            <div 
                                className="absolute inset-0 cursor-move pointer-events-auto hover:bg-indigo-500/10 transition-colors"
                                onPointerDown={handleBoxDown}
                            />
                            
                            <div className="absolute inset-0 border-2 border-indigo-500 pointer-events-none" />

                            {tool !== 'pan' && (
                                <>
                                    <div 
                                      className="absolute top-1/2 -translate-y-1/2 -right-3 w-4 h-4 bg-white border border-indigo-500 rounded-full shadow-md flex items-center justify-center cursor-e-resize z-50 pointer-events-auto hover:scale-110 transition-transform"
                                      onPointerDown={(e) => handleHandleDown(e, 'resizing-e')}
                                    />

                                    <div 
                                      className="absolute left-1/2 -translate-x-1/2 -bottom-3 w-4 h-4 bg-white border border-indigo-500 rounded-full shadow-md flex items-center justify-center cursor-s-resize z-50 pointer-events-auto hover:scale-110 transition-transform"
                                      onPointerDown={(e) => handleHandleDown(e, 'resizing-s')}
                                    />

                                    <div 
                                      className="absolute -bottom-3 -right-3 w-4 h-4 bg-white border border-indigo-500 rounded-full shadow-md flex items-center justify-center cursor-se-resize z-50 pointer-events-auto hover:scale-110 transition-transform"
                                      onPointerDown={(e) => handleHandleDown(e, 'resizing-se')}
                                    >
                                      <ArrowDownRight size={10} className="text-indigo-600" />
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
        </div>
      </div>

      {/* 2. Top Controls - REMOVED (Moved to App.tsx) */}

      {/* 3. Bottom Controls (Navigation Only) */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center justify-center z-[70] pointer-events-none">
         <div className="pointer-events-auto flex items-center space-x-1 bg-slate-900/90 backdrop-blur-xl border border-white/10 rounded-full px-2 py-1.5 shadow-2xl">
            <button 
              onClick={() => {
                  // Prev Page via Button: Top
                  preservedScrollRatio.current = { x: getCurrentXRatio(), y: 0 };
                  setCurrentPageIndex(Math.max(0, currentPageIndex - 1))
              }}
              disabled={currentPageIndex === 0}
              className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-white"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="flex items-center space-x-2 px-3">
                <span className="text-sm font-medium text-white/90">
                    Page
                </span>
                <span className="font-mono text-sm text-indigo-300 font-bold min-w-[2ch] text-center">
                   {currentPageIndex + 1}
                </span>
                <span className="text-white/40 text-sm">/</span>
                <span className="text-sm text-white/70">
                   {pageImages.length}
                </span>
            </div>
            <button 
              onClick={() => {
                  // Next Page via Button: Top
                  preservedScrollRatio.current = { x: getCurrentXRatio(), y: 0 };
                  setCurrentPageIndex(Math.min(pageImages.length - 1, currentPageIndex + 1))
              }}
              disabled={currentPageIndex === pageImages.length - 1}
              className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-white"
            >
              <ChevronRight size={20} />
            </button>
         </div>
      </div>

    </div>
  );
});

ManualCropper.displayName = 'ManualCropper';