/**
 * Get the mod, and learn how to use it.
 *
 * "Send to game" tells a player to type `/craftmagic pair ABC123` — a command that does not
 * exist until they have installed a mod, on a loader they may not have, on a Minecraft version
 * that has to match. This page is the missing half of that instruction.
 *
 * The version, size and Minecraft version are read from `/mod/manifest.json`, which
 * `tools/bundle-mod.mjs` writes next to the jar, rather than being typed into this file. A
 * page that claims "for Minecraft 26.2" while serving a jar built for something else is worse
 * than one that says nothing, and hardcoding is how that happens.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './mod.css';

interface ModManifest {
  file: string;
  version: string;
  minecraft: string;
  loader: string;
  loaderVersion?: string;
  java?: number;
  bytes: number;
  builtAt: string;
}

function formatBytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function ModPage() {
  const [manifest, setManifest] = useState<ModManifest | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/mod/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: ModManifest) => !cancelled && setManifest(m))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="modpage" data-ready={manifest || failed ? '1' : '0'}>
      <header className="modpage__head">
        <div>
          <h1 className="modpage__title">Get the mod</h1>
          <p className="modpage__sub">
            Installs once. After that, any build on this site can be sent straight into your world.
          </p>
        </div>
        <Link className="modpage__back" to="/">
          ← Back to the editor
        </Link>
      </header>

      <section className="panel modpage__download">
        {manifest ? (
          <>
            <a className="modpage__button" href={manifest.file} download>
              Download for Minecraft {manifest.minecraft}
            </a>
            <p className="modpage__meta">
              v{manifest.version} · {formatBytes(manifest.bytes)} · Fabric
              {manifest.loaderVersion ? ` ${manifest.loaderVersion}` : ''} · requires Java{' '}
              {manifest.java ?? 25}
            </p>
          </>
        ) : failed ? (
          <p className="modpage__error" role="alert">
            The mod could not be listed just now. Try reloading — if it keeps happening, the
            download has not been published yet.
          </p>
        ) : (
          <p className="modpage__meta">Looking up the current version…</p>
        )}
      </section>

      <section className="panel">
        <h2>Install it</h2>
        <ol className="modpage__steps">
          <li>
            <strong>Install Fabric.</strong> Get the installer from{' '}
            <a href="https://fabricmc.net/use/installer/" target="_blank" rel="noreferrer">
              fabricmc.net
            </a>{' '}
            and run it for Minecraft {manifest?.minecraft ?? '26.2'}. This adds a “Fabric” profile
            to your launcher — your normal Minecraft is untouched.
          </li>
          <li>
            <strong>Drop the jar in your mods folder.</strong> Windows:{' '}
            <code>%appdata%\.minecraft\mods</code> · macOS:{' '}
            <code>~/Library/Application Support/minecraft/mods</code> · Linux:{' '}
            <code>~/.minecraft/mods</code>. Create the folder if it isn’t there.
          </li>
          <li>
            <strong>Launch the Fabric profile</strong> and open a world — single-player is fine.
          </li>
        </ol>
        <p className="modpage__note">
          Nothing else to install. The mod bundles the parts of the Fabric API it uses, so this is
          the only file you need.
        </p>
      </section>

      <section className="panel">
        <h2>Pair it with your account</h2>
        <ol className="modpage__steps">
          <li>
            In the editor, open <strong>Send to game</strong> and choose{' '}
            <strong>Pair a world…</strong>. You’ll get a six-character code.
          </li>
          <li>
            In Minecraft, type <code>/craftmagic pair ABC123</code> with that code. The world
            appears on the site within a second or two.
          </li>
          <li>
            Click <strong>Build here</strong>, then in game run <code>/craftmagic build</code>{' '}
            where you want it. A builder bot appears and places the blocks.
          </li>
        </ol>
        <p className="modpage__note">
          Codes expire after ten minutes and can be used once. Pairing links that world to your
          account, so nobody else can send builds to it.
        </p>
      </section>

      <section className="panel">
        <h2>Commands</h2>
        <dl className="modpage__commands">
          <dt>
            <code>/craftmagic pair &lt;code&gt;</code>
          </dt>
          <dd>Link this world to your account.</dd>

          <dt>
            <code>/craftmagic build</code>
          </dt>
          <dd>Place the pending build at where you are standing.</dd>

          <dt>
            <code>/craftmagic place &lt;x&gt; &lt;y&gt; &lt;z&gt;</code>
          </dt>
          <dd>Place it at exact coordinates instead.</dd>

          <dt>
            <code>/craftmagic speed &lt;n&gt;</code>
          </dt>
          <dd>Blocks placed per second. <code>0</code> places everything at once.</dd>

          <dt>
            <code>/craftmagic status</code>
          </dt>
          <dd>Show whether this world is paired, and to which server.</dd>

          <dt>
            <code>/craftmagic unpair</code>
          </dt>
          <dd>Forget the pairing and disconnect.</dd>
        </dl>
        <p className="modpage__note">
          On a dedicated server these need operator permission. On your own single-player world
          you already have it.
        </p>
      </section>

      <section className="panel">
        <h2>If something doesn’t work</h2>
        <dl className="modpage__commands">
          <dt>The command isn’t recognised</dt>
          <dd>
            Minecraft is running without the mod — check you launched the Fabric profile and that
            the jar is in <code>mods</code>.
          </dd>

          <dt>Pairing says the code is invalid</dt>
          <dd>Codes last ten minutes and work once. Generate a fresh one.</dd>

          <dt>The world never comes online</dt>
          <dd>
            The mod dials out to this site over WebSocket. A firewall that blocks outbound
            connections will stop it; run <code>/craftmagic status</code> to see which server it
            is trying.
          </dd>

          <dt>Blocks stop partway through</dt>
          <dd>
            Building pauses in unloaded chunks. Stay near the site, or lower{' '}
            <code>/craftmagic speed</code> so it keeps up.
          </dd>
        </dl>
      </section>
    </div>
  );
}
