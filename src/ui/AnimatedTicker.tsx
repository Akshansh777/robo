import React, { useEffect, useRef, useState } from 'react';

export const AnimatedTicker: React.FC<{
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}> = ({ value, decimals = 0, suffix = '', className = 'display-num' }) => {
  const [display, setDisplay] = useState(value);
  const currentRef = useRef(value);

  useEffect(() => {
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      currentRef.current = value;
      setDisplay(value);
      return;
    }

    const startVal = currentRef.current;
    const diff = value - startVal;
    if (Math.abs(diff) < 1e-4) {
      setDisplay(value);
      return;
    }

    let raf = 0;
    const startTime = performance.now();
    const duration = 220;

    const animate = (now: number) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = startVal + diff * eased;
      currentRef.current = next;
      setDisplay(next);
      if (progress < 1) {
        raf = requestAnimationFrame(animate);
      }
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className={className}>
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
};
