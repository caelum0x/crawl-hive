"use client";
// Визуал CrawlHive Brain: живая нейросеть на canvas (узлы медленно плывут, ближние связаны, по связям бегут
// импульсы) и поверх неё светящийся осьминог-мозг (PNG с прозрачным фоном, чёрное вырезано).
// Без анимации при prefers-reduced-motion, и на паузе, пока блок не виден на экране.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const COLORS = ["#f472b6", "#a78bfa", "#22d3ee"];
const LINK = 0.2; // доля меньшей стороны, на которой узлы ещё связаны

type Node = { x: number; y: number; vx: number; vy: number; r: number; c: string };
type Pulse = { a: number; b: number; t: number; c: string };

export function BrainNeurons({ className, nodes = 70 }: { className?: string; nodes?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current;
    const canvas = cv.current;
    const ctx = canvas?.getContext("2d");
    if (!el || !canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let pts: Node[] = [];
    const pulses: Pulse[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = el.clientWidth;
      h = el.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!pts.length)
        pts = Array.from({ length: nodes }, (_, i) => ({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          r: 1.2 + Math.random() * 2.2,
          c: COLORS[i % COLORS.length],
        }));
    };

    const draw = () => {
      const max = Math.min(w, h) * LINK + 60;
      ctx.clearRect(0, 0, w, h);
      const near: [number, number][] = [];
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (d > max) continue;
          near.push([i, j]);
          ctx.strokeStyle = pts[i].c;
          ctx.globalAlpha = 0.45 * (1 - d / max);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      for (const p of pts) {
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Импульсы: изредка новый по случайной связи, бежит от узла к узлу.
      if (!still && near.length && pulses.length < 14 && Math.random() < 0.08) {
        const [a, b] = near[(Math.random() * near.length) | 0];
        pulses.push({ a, b, t: 0, c: COLORS[(Math.random() * COLORS.length) | 0] });
      }
      for (let k = pulses.length - 1; k >= 0; k--) {
        const q = pulses[k];
        q.t += 0.025;
        if (q.t >= 1) {
          pulses.splice(k, 1);
          continue;
        }
        const x = pts[q.a].x + (pts[q.b].x - pts[q.a].x) * q.t;
        const y = pts[q.a].y + (pts[q.b].y - pts[q.a].y) * q.t;
        ctx.globalAlpha = 1;
        ctx.fillStyle = q.c;
        ctx.shadowColor = q.c;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    };

    const step = () => {
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
    };

    let raf = 0;
    let on = false;
    const loop = () => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (on || still) return;
      on = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      on = false;
      cancelAnimationFrame(raf);
    };

    resize();
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()));
    io.observe(el);
    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
    };
  }, [nodes]);

  return (
    <div ref={box} className={cn("relative overflow-hidden", className)}>
      <canvas ref={cv} className="absolute inset-0 h-full w-full" aria-hidden />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(34,211,238,0.22),transparent_55%)]" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brain/octo-brain.png"
        alt="CrawlHive Brain: a glowing octopus with a brain made of neurons"
        className="pointer-events-none absolute inset-0 m-auto aspect-square h-[88%] max-h-[460px] drop-shadow-[0_0_28px_rgba(34,211,238,0.35)] motion-safe:animate-[brainfloat_6s_ease-in-out_infinite]"
      />
      {/* центр задаёт inset-0 + m-auto, поэтому анимация двигает только по вертикали и не сбивает его */}
      <style>{`@keyframes brainfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}`}</style>
    </div>
  );
}
