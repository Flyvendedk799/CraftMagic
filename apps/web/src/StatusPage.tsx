import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AGENT_PROTOCOL_VERSION } from '@craftmagic/core';

type Check = { status: 'pending' | 'ok' | 'fail'; detail: string };

const pending: Check = { status: 'pending', detail: 'checking…' };

/**
 * M0 status page. It is not a placeholder: the WebSocket round-trip here is the same
 * upgrade path the mod uses, so loading this page against the deployed server is the
 * deployment smoke test.
 */
export function StatusPage() {
  const [api, setApi] = useState<Check>(pending);
  const [ws, setWs] = useState<Check>(pending);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { service: string; version: string }) => {
        if (!cancelled) setApi({ status: 'ok', detail: `${body.service} v${body.version}` });
      })
      .catch((err: Error) => {
        if (!cancelled) setApi({ status: 'fail', detail: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runWsCheck = useCallback(() => {
    setWs(pending);
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/agent/ws-echo`);
    const started = performance.now();
    const timeout = window.setTimeout(() => {
      setWs({ status: 'fail', detail: 'timed out after 5s — is the upgrade being proxied?' });
      socket.close();
    }, 5000);

    socket.onopen = () => socket.send('ping');
    socket.onmessage = (event) => {
      window.clearTimeout(timeout);
      const ms = Math.round(performance.now() - started);
      setWs({ status: 'ok', detail: `echoed "${String(event.data)}" in ${ms}ms` });
      socket.close();
    };
    socket.onerror = () => {
      window.clearTimeout(timeout);
      setWs({ status: 'fail', detail: 'connection failed' });
    };

    return () => {
      window.clearTimeout(timeout);
      socket.close();
    };
  }, []);

  useEffect(() => runWsCheck(), [runWsCheck]);

  return (
    <main className="shell">
      <header>
        <h1>CraftMagic</h1>
        <p className="tagline">
          Describe a build. Get a schematic, an instruction booklet, or a bot that builds it in
          your world.
        </p>
      </header>

      <section className="panel">
        <h2>Milestone 0 — scaffold</h2>
        <ul className="checks">
          <CheckRow label="API" check={api} />
          <CheckRow label="Agent WebSocket" check={ws} />
          <CheckRow
            label="Agent protocol"
            check={{ status: 'ok', detail: `version ${AGENT_PROTOCOL_VERSION}` }}
          />
        </ul>
        <button type="button" onClick={runWsCheck}>
          Re-run WebSocket check
        </button>
      </section>

      <p className="tagline" style={{ marginTop: '2rem' }}>
        <Link to="/">← Back to the editor</Link>
      </p>
    </main>
  );
}

function CheckRow({ label, check }: { label: string; check: Check }) {
  return (
    <li className={`check check--${check.status}`}>
      <span className="check__label">{label}</span>
      <span className="check__detail">{check.detail}</span>
    </li>
  );
}
