"use client";

import { useEffect, useState } from "react";
import type { MemoryAt } from "@/lib/queries";
import { Sql } from "./ui";

/**
 * Drag the slider; watch the agent's mind change.
 *
 * Each stop is a real HLC captured at a real decision, so every position on this
 * track is a moment the agent actually read memory — not an interpolation.
 */
export function Scrubber({ decisions }: { decisions: { hlc: string; at: string }[] }) {
  const [i, setI] = useState(decisions.length - 1);
  const [memories, setMemories] = useState<MemoryAt[] | null>(null);
  const [loading, setLoading] = useState(false);

  const point = decisions[i];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/memory-at?hlc=${encodeURIComponent(point.hlc)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setMemories(d.memories ?? []);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [point.hlc]);

  return (
    <div className="border border-line bg-surface">
      <div className="border-b border-line px-6 py-7 sm:px-8">
        <input
          type="range"
          min={0}
          max={decisions.length - 1}
          value={i}
          onChange={(e) => setI(Number(e.target.value))}
          aria-label="Move through the agent's memory history"
        />
        <div className="mt-4 flex items-baseline justify-between font-mono text-[11px] tracking-[0.1em]">
          <span className="text-faint">{decisions[0].at.slice(0, 19)}</span>
          <span className="text-[15px] tracking-[0.04em] text-text tabular-nums">
            {point.at.slice(0, 19)}
          </span>
          <span className="text-faint">{decisions[decisions.length - 1].at.slice(0, 19)}</span>
        </div>
      </div>

      <div className="px-6 py-6 sm:px-8">
        <Sql>{`SELECT subject, content FROM memory
AS OF SYSTEM TIME ${point.hlc}
WHERE tenant_id = $1 AND valid;`}</Sql>

        <div className={`mt-6 ${loading && !memories ? "opacity-40" : ""}`}>
          {memories?.map((m) => {
            const suspect = m.trust_score !== null && m.trust_score < 0.5;
            return (
              <div
                key={m.memory_id}
                className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:gap-6"
              >
                <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-faint sm:w-72 sm:pt-0.5">
                  {m.subject}
                </span>
                <span
                  className={`min-w-0 flex-1 font-mono text-[13px] ${
                    suspect ? "text-bad" : "text-text"
                  }`}
                >
                  {m.content}
                </span>
                {suspect ? (
                  <span className="shrink-0 border border-bad px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-bad">
                    trust {m.trust_score}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="mt-6 font-mono text-[11px] leading-relaxed tracking-[0.08em] text-faint">
          The agent&rsquo;s complete belief state at that instant. Nothing was stored to make it
          available.
        </p>
      </div>
    </div>
  );
}
