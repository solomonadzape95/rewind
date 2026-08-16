import type { ReactNode } from "react";

/** Numbered section rule. Keeps the three demo beats visually countable. */
export function SectionLabel({
  n,
  title,
  meta,
}: {
  n: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className="mb-4 flex items-baseline gap-4 border-b border-line pb-3">
      <span className="font-mono text-[12px] tracking-[0.2em] text-faint">{n}</span>
      <h2 className="font-mono text-[12px] uppercase tracking-[0.24em] text-muted">{title}</h2>
      {meta ? (
        <span className="ml-auto font-mono text-[11px] tracking-[0.12em] text-faint">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

/** A SQL statement shown as evidence, not as decoration. */
export function Sql({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto border border-line-strong bg-bg px-5 py-4 font-mono text-[12.5px] leading-relaxed text-muted">
      {children}
    </pre>
  );
}

/** Definition row used across the verdict and trace panels. */
export function Field({
  k,
  children,
  tone,
}: {
  k: string;
  children: ReactNode;
  tone?: "bad" | "good";
}) {
  const color = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-text";
  return (
    <div className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:gap-6">
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-faint sm:w-40 sm:pt-0.5">
        {k}
      </span>
      <span className={`min-w-0 flex-1 break-words font-mono text-[13px] ${color}`}>
        {children}
      </span>
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="border border-line bg-surface p-6 sm:p-8">{children}</div>;
}
