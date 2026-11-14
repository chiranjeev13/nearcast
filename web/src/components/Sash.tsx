import { useRef, useState } from "react";

/**
 * VS Code's sash: a thin drag handle between two panes. Reports the new size of the pane before it
 * (vertical: width from the left edge of `container`; horizontal: height from the bottom).
 */
export function Sash({ dir, onSize, onReset, min, max, style }: {
  style?: React.CSSProperties;
  dir: "vertical" | "horizontal";
  onSize: (px: number) => void;
  onReset: () => void;
  min: number;
  max: () => number;
}) {
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const vertical = dir === "vertical";
  return (
    <div
      ref={ref}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = ref.current!;
        el.setPointerCapture(e.pointerId);
        setDrag(true);
        // Measured against the nearest container marked data-sash-root.
        const parent = (el.closest("[data-sash-root]") ?? el.parentElement!).getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const raw = vertical ? ev.clientX - parent.left : parent.bottom - ev.clientY;
          onSize(Math.max(min, Math.min(max(), raw)));
        };
        const up = () => {
          setDrag(false);
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
      className={`group absolute z-20 ${vertical ? "top-0 bottom-0 w-[6px] -ml-[3px] cursor-col-resize" : "left-0 right-0 h-[6px] -mt-[3px] cursor-row-resize"}`}
      style={{ touchAction: "none", ...style }}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
    >
      <div
        className={`absolute transition-colors delay-100 ${drag ? "bg-accent" : "bg-transparent group-hover:bg-accent"} ${vertical ? "top-0 bottom-0 left-[1px] w-[4px]" : "left-0 right-0 top-[1px] h-[4px]"}`}
      />
    </div>
  );
}
