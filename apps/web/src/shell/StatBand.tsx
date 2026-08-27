/**
 * A row of numbers, above the thing they describe.
 *
 * One band, not a row of cards. The dashboard used to draw four bordered tiles here and the
 * library was about to grow its own copy; four tiles is the weight of four *subjects*, and
 * on both pages the subject is the builds underneath. So this is deliberately quiet: one
 * surface, hairlines between the numbers, and the number itself is the only thing at size.
 *
 * A definition list because that is literally what it is — a label and the value of that
 * label, four times — and because it gives a screen reader the pairing for free.
 */

import { Link } from 'react-router-dom';
import './statband.css';

export interface Stat {
  label: string;
  value: string;
  /** A qualifier that only means something beside the number: "of 30 today", "in your library". */
  note?: string;
  /** Where the number leads, if anywhere. Absent is a normal state, not a missing feature. */
  to?: string;
  /** 0–1. Draws a bar under the value, for a number that is a fraction of a known whole. */
  meter?: number;
}

export function StatBand({ label, stats }: { label: string; stats: Stat[] }) {
  return (
    <dl className="totals" aria-label={label}>
      {stats.map((stat) => (
        <div className="totals__item" key={stat.label}>
          <dt>{stat.label}</dt>
          <dd>
            {stat.to ? (
              <Link className="totals__link" to={stat.to}>
                {stat.value}
              </Link>
            ) : (
              stat.value
            )}
            {stat.note && <span className="totals__unit"> {stat.note}</span>}
          </dd>
          {stat.meter !== undefined && (
            <span className="totals__meter" aria-hidden="true">
              <span style={{ width: `${Math.round(clamp(stat.meter) * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
    </dl>
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
