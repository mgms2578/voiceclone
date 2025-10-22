import { useEffect, useRef } from 'react';

interface WaveformProps {
  isRecording: boolean;
  audioLevel?: number;
}

export function Waveform({ isRecording, audioLevel = 0 }: WaveformProps) {
  const barsRef = useRef<HTMLDivElement[]>([]);
  
  useEffect(() => {
    if (!isRecording) return;
    
    const interval = setInterval(() => {
      barsRef.current.forEach((bar) => {
        if (bar) {
          const height = Math.random() * 40 + 8 + (audioLevel * 20);
          bar.style.height = `${Math.min(height, 48)}px`;
        }
      });
    }, 100);
    
    return () => clearInterval(interval);
  }, [isRecording, audioLevel]);
  
  return (
    <div className="flex items-end justify-center space-x-1 h-24" data-testid="waveform-container">
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            if (el) barsRef.current[i] = el;
          }}
          className="bg-kiosk-primary rounded-full transition-all duration-200 waveform-animation"
          style={{ 
            width: '4px', 
            height: isRecording ? '8px' : '8px',
            '--target-height': `${Math.random() * 40 + 8}px`
          } as React.CSSProperties}
          data-testid={`waveform-bar-${i}`}
        />
      ))}
    </div>
  );
}
