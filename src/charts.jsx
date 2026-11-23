import React, { useMemo, useState } from 'react';

const palette = ['#3477df', '#25a990', '#e7a74f', '#8268be', '#d46c62', '#6c9f9a', '#55708d', '#b77d9b'];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatQuantity(value) {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(number(value));
}

export function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number(value));
}

export function formatChartDay(value) {
  if (!value) return '—';
  const raw = String(value);
  const monthOnly = /^\d{4}-\d{2}$/.test(raw);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(monthOnly ? `${raw}-01T12:00:00Z` : dateOnly ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return '—';
  if (monthOnly && date.toISOString().slice(0, 7) !== raw) return '—';
  if (dateOnly && date.toISOString().slice(0, 10) !== raw) return '—';
  return new Intl.DateTimeFormat('en', monthOnly ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

export function DonutChart({ data = [], valueKey = 'value', labelKey = 'label', colors = palette, centerValue, centerLabel = 'TOTAL', formatter = formatQuantity, emptyLabel = 'No records to chart' }) {
  const [active, setActive] = useState(null);
  const values = useMemo(() => data.map(row => Math.max(0, number(row[valueKey]))), [data, valueKey]);
  const total = values.reduce((sum, value) => sum + value, 0);
  const circumference = 2 * Math.PI * 67;
  let offset = 0;
  if (!data.length || total <= 0) return <div className="viz-empty"><span className="viz-empty-ring"/><b>{emptyLabel}</b><small>There is no quantity to display for this selection.</small></div>;

  const selected = active == null ? null : data[active];
  return <div className="donut-layout">
    <div className="donut-visual">
      <svg className="donut-svg" viewBox="0 0 220 220" role="img" aria-label={`${centerLabel}: ${formatter(total)}`}>
        <title>{`${centerLabel}: ${formatter(total)}`}</title>
        <circle cx="110" cy="110" r="67" fill="none" stroke="#e9eeea" strokeWidth="25"/>
        {data.map((row, index) => {
          const length = circumference * values[index] / total;
          const start = offset;
          offset += length;
          return <circle key={`${row[labelKey]}-${index}`} className={`donut-segment ${active === index ? 'is-active' : ''}`} cx="110" cy="110" r="67" fill="none" stroke={colors[index % colors.length]} strokeWidth="25" strokeDasharray={`${Math.max(0, length - 1.5)} ${circumference - Math.max(0, length - 1.5)}`} strokeDashoffset={-start} transform="rotate(-90 110 110)" tabIndex={0} role="button" aria-label={`${row[labelKey]}: ${formatter(values[index])}`} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>
            <title>{`${row[labelKey]}: ${formatter(values[index])}`}</title>
          </circle>;
        })}
        <text x="110" y="105" className="donut-center-value">{selected ? formatter(values[active]) : (centerValue ?? formatter(total))}</text>
        <text x="110" y="127" className="donut-center-label">{selected ? String(selected[labelKey]).toUpperCase() : centerLabel}</text>
      </svg>
    </div>
    <div className="donut-legend" role="list" aria-label="Chart legend">
      {data.map((row, index) => <div className={`donut-legend-row ${active === index ? 'is-active' : ''}`} key={`${row[labelKey]}-legend-${index}`} role="listitem" onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(index)} tabIndex={0}>
        <i style={{ background: colors[index % colors.length] }}/><span>{row[labelKey]}</span><b>{formatter(values[index])}</b><small>{total ? `${Math.round(values[index] / total * 100)}%` : '0%'}</small>
      </div>)}
    </div>
  </div>;
}

function makeLine(values, xAt, yAt) {
  return values.map((value, index) => `${index ? 'L' : 'M'} ${xAt(index)} ${yAt(value)}`).join(' ');
}

export function MovementLineChart({ data = [], onEmpty = 'No stock movements in this date range' }) {
  const [active, setActive] = useState(Math.max(0, data.length - 1));
  const safeActive = Math.min(active, Math.max(0, data.length - 1));
  const max = Math.max(1, ...data.flatMap(row => [number(row.inbound), number(row.outbound)]));
  const xAt = index => data.length < 2 ? 500 : 72 + index / (data.length - 1) * 888;
  const yAt = value => 252 - number(value) / max * 204;
  const inbound = makeLine(data.map(row => row.inbound), xAt, yAt);
  const outbound = makeLine(data.map(row => row.outbound), xAt, yAt);
  const inboundArea = `${inbound} L ${xAt(data.length - 1)} 260 L ${xAt(0)} 260 Z`;
  const outboundArea = `${outbound} L ${xAt(data.length - 1)} 260 L ${xAt(0)} 260 Z`;
  const selected = data[safeActive];

  function selectFromPointer(event) {
    if (data.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const plotX = (event.clientX - rect.left) / rect.width * 1000;
    setActive(Math.max(0, Math.min(data.length - 1, Math.round((plotX - 72) / 888 * (data.length - 1)))));
  }
  function moveFocus(event) {
    if (event.key === 'ArrowRight') { event.preventDefault(); setActive(index => Math.min(data.length - 1, index + 1)); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, data.length - 1)); }
  }

  if (!data.length) return <div className="viz-empty line-empty"><span className="viz-empty-wave">↗</span><b>{onEmpty}</b><small>Try a wider date range after stock activity is recorded.</small></div>;
  const gridValues = [max, max * .5, 0];
  return <div className="line-chart-wrap">
    <div className="line-chart-detail" role="status" aria-live="polite"><span>{formatChartDay(selected?.day ?? selected?.month)}</span><b><i className="legend-in"/> In {formatQuantity(selected?.inbound)}</b><b><i className="legend-out"/> Out {formatQuantity(selected?.outbound)}</b>{selected?.movements != null && <small>{formatQuantity(selected.movements)} movements</small>}</div>
    <svg className="movement-svg" viewBox="0 0 1000 310" role="img" tabIndex={0} aria-label="Stock in and stock out over time. Use the left and right arrow keys to inspect dates." onPointerMove={selectFromPointer} onPointerLeave={() => setActive(Math.max(0, data.length - 1))} onFocus={() => setActive(Math.max(0, data.length - 1))} onKeyDown={moveFocus}>
      <title>Inbound and outbound units over time</title>
      <defs><linearGradient id="stock-in-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#4389ec" stopOpacity=".3"/><stop offset="1" stopColor="#4389ec" stopOpacity="0"/></linearGradient><linearGradient id="stock-out-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#45b99f" stopOpacity=".2"/><stop offset="1" stopColor="#45b99f" stopOpacity="0"/></linearGradient></defs>
      {gridValues.map((value, index) => { const y = yAt(value); return <g key={index}><line x1="70" x2="970" y1={y} y2={y} className="chart-gridline"/><text x="56" y={y + 4} textAnchor="end" className="chart-axis-label">{formatQuantity(value)}</text></g>; })}
      <path d={inboundArea} fill="url(#stock-in-fill)" className="chart-area"/><path d={outboundArea} fill="url(#stock-out-fill)" className="chart-area"/>
      <path d={inbound} pathLength="1" className="chart-line chart-line-in"/><path d={outbound} pathLength="1" className="chart-line chart-line-out"/>
      {selected && <g className="chart-selection"><line x1={xAt(safeActive)} x2={xAt(safeActive)} y1="36" y2="260"/><circle cx={xAt(safeActive)} cy={yAt(selected.inbound)} r="5"/><circle cx={xAt(safeActive)} cy={yAt(selected.outbound)} r="5"/></g>}
      {[0, Math.floor((data.length - 1) / 2), data.length - 1].filter((index, pos, list) => list.indexOf(index) === pos).map(index => <text key={index} x={xAt(index)} y="293" textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'} className="chart-axis-label">{formatChartDay(data[index].day ?? data[index].month)}</text>)}
    </svg>
  </div>;
}

export function HorizontalBarChart({ data = [], labelKey = 'warehouse_name', valueKey = 'units', formatter = formatQuantity, emptyLabel = 'No warehouse inventory to compare', color = '#3477df' }) {
  const [active, setActive] = useState(null);
  const max = Math.max(0, ...data.map(row => number(row[valueKey])));
  if (!data.length) return <div className="viz-empty"><span className="viz-empty-bars">▥</span><b>{emptyLabel}</b><small>There is no data to compare for this selection.</small></div>;
  const selected = active == null ? null : data[active];
  return <div className="horizontal-bar-chart">
    {selected && <div className="bar-chart-tooltip" role="status"><span>{selected[labelKey]}</span><b>{formatter(selected[valueKey])}</b></div>}
    <div className="bar-chart-rows" role="list" aria-label="Warehouse comparison">
      {data.map((row, index) => <div className={`bar-chart-row ${active === index ? 'is-active' : ''}`} role="listitem" tabIndex={0} aria-label={`${row[labelKey]}: ${formatter(row[valueKey])}`} title={`${row[labelKey]} · ${formatter(row[valueKey])}`} key={`${row[labelKey]}-${index}`} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>
        <span className="bar-chart-label">{row[labelKey]}{row.active === 0 && <small>Inactive</small>}</span><span className="bar-chart-track"><i style={{ width: `${max ? number(row[valueKey]) / max * 100 : 0}%`, background: color }}/></span><b>{formatter(row[valueKey])}</b>
      </div>)}
    </div>
  </div>;
}
