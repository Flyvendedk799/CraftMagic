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

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppNav } from '../shell/AppNav.js';
import { useAgents } from '../agent/useAgents.js';
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

type SetupTab = 'singleplayer' | 'dedicated' | 'lan';

function formatBytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; user can still select/type.
    }
  }, [command]);

  return (
    <span className="modpage__copy-command">
      <code>{command}</code>
      <button
        type="button"
        className={`modpage__copy-btn ${copied ? 'modpage__copy-btn--copied' : ''}`}
        onClick={() => void handleCopy()}
        aria-label={`Copy command ${command}`}
        title={`Copy ${command}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function ConnectionStatusCard() {
  const { agents, available, needsAccount, loading } = useAgents();

  const onlineAgent = agents.find((a) => a.online);
  const offlineAgent = agents.find((a) => !a.online);

  if (!available) {
    return null;
  }

  return (
    <section className="panel modpage__status-card" aria-label="Minecraft connection status">
      <div className="modpage__status-header">
        <div className="modpage__status-info">
          <span className="modpage__status-eyebrow">Connection Status</span>
          {loading ? (
            <h2 className="modpage__status-title">Checking paired worlds…</h2>
          ) : onlineAgent ? (
            <h2 className="modpage__status-title">
              <span className="modpage__status-dot modpage__status-dot--online" aria-hidden="true" />
              Connected to {onlineAgent.name}
            </h2>
          ) : agents.length > 0 ? (
            <h2 className="modpage__status-title">
              <span className="modpage__status-dot modpage__status-dot--offline" aria-hidden="true" />
              {offlineAgent?.name ?? 'World'} is offline
            </h2>
          ) : needsAccount ? (
            <h2 className="modpage__status-title">Sign in to pair Minecraft</h2>
          ) : (
            <h2 className="modpage__status-title">No Minecraft world paired</h2>
          )}
        </div>

        {onlineAgent && (
          <span className="modpage__status-badge modpage__status-badge--online">Online</span>
        )}
      </div>

      <div className="modpage__status-body">
        {loading ? (
          <p className="modpage__status-desc">Looking up connected Minecraft worlds…</p>
        ) : onlineAgent ? (
          <>
            <p className="modpage__status-desc">
              Minecraft {onlineAgent.mcVersion ?? 'world'} is connected and ready to receive builds.
            </p>
            <div className="modpage__status-actions">
              <Link to="/studio?mode=build" className="modpage__card-link modpage__card-link--primary">
                Send to Game
              </Link>
              <Link to="/studio" className="modpage__card-link">
                Open Studio
              </Link>
            </div>
          </>
        ) : agents.length > 0 ? (
          <>
            <p className="modpage__status-desc">
              Your paired world is offline. Launch Minecraft and load your world to reconnect — the
              mod connects automatically.
            </p>
            <div className="modpage__status-actions">
              <Link to="/dashboard" className="modpage__card-link">
                Manage worlds
              </Link>
            </div>
          </>
        ) : needsAccount ? (
          <>
            <p className="modpage__status-desc">
              Pairing links your Minecraft world to your CraftMagic account so no one else can send
              builds to it. Sign in or create an account to get started.
            </p>
            <div className="modpage__status-actions">
              <Link to="/dashboard" className="modpage__card-link modpage__card-link--primary">
                Sign in to pair
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="modpage__status-desc">
              No Minecraft world is paired yet. Follow the guide below to install the mod, then
              generate a pairing code to link your world.
            </p>
            <div className="modpage__status-actions">
              <Link to="/dashboard" className="modpage__card-link modpage__card-link--primary">
                Pair Minecraft
              </Link>
              <Link to="/studio" className="modpage__card-link">
                Open Studio
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function ModPage() {
  const [manifest, setManifest] = useState<ModManifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeTab, setActiveTab] = useState<SetupTab>('singleplayer');

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
    <>
      <AppNav current="mod" />

      <div className="modpage" data-ready={manifest || failed ? '1' : '0'}>
        <header className="modpage__head">
          <div>
            <h1 className="modpage__title">Get the mod</h1>
            <p className="modpage__sub">
              Installs once. After that, any build on this site can be sent straight into your
              Minecraft world. Pairing links that world to your CraftMagic account, so you need
              one — <Link to="/dashboard?signup=1">create it here</Link> if you have not yet.
            </p>
          </div>
        </header>

        {/* Live connection status card */}
        <ConnectionStatusCard />

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
            <strong>You do not need the Fabric API jar.</strong> Most mods ask you to install it
            separately; this one bundles the parts it uses, so the file above is the only one that
            goes in your mods folder. If you already run the full Fabric API, that keeps working —
            Fabric just uses whichever version is newer.
          </p>
        </section>

        {/* Tabbed Setup Guides */}
        <section className="panel">
          <h2>Setup Guides</h2>

          <div className="modpage__tabs" role="tablist" aria-label="Setup guide environments">
            <button
              type="button"
              role="tab"
              id="tab-singleplayer"
              aria-selected={activeTab === 'singleplayer'}
              aria-controls="panel-singleplayer"
              className={`modpage__tab ${activeTab === 'singleplayer' ? 'modpage__tab--active' : ''}`}
              onClick={() => setActiveTab('singleplayer')}
            >
              Singleplayer (Solo)
            </button>
            <button
              type="button"
              role="tab"
              id="tab-dedicated"
              aria-selected={activeTab === 'dedicated'}
              aria-controls="panel-dedicated"
              className={`modpage__tab ${activeTab === 'dedicated' ? 'modpage__tab--active' : ''}`}
              onClick={() => setActiveTab('dedicated')}
            >
              Dedicated Server (Multiplayer)
            </button>
            <button
              type="button"
              role="tab"
              id="tab-lan"
              aria-selected={activeTab === 'lan'}
              aria-controls="panel-lan"
              className={`modpage__tab ${activeTab === 'lan' ? 'modpage__tab--active' : ''}`}
              onClick={() => setActiveTab('lan')}
            >
              LAN / Friends
            </button>
          </div>

          {activeTab === 'singleplayer' && (
            <div
              id="panel-singleplayer"
              role="tabpanel"
              aria-labelledby="tab-singleplayer"
              className="modpage__tabpanel"
            >
              <ol className="modpage__steps">
                <li>
                  <strong>Open your singleplayer world.</strong> Cheats and operator permissions are{' '}
                  <strong>not required</strong> — CraftMagic works straight out of the box in
                  standard survival or creative mode.
                </li>
                <li>
                  <strong>Pair your world.</strong> On your <Link to="/dashboard">dashboard</Link> or
                  in the studio, click <strong>Pair Minecraft</strong> to generate a 6-character
                  pairing code. In Minecraft, run:
                  <div className="modpage__step-cmd">
                    <CopyCommand command="/craftmagic pair <code>" />
                  </div>
                </li>
                <li>
                  <strong>Build with the wand.</strong> Once connected, click{' '}
                  <strong>Build here</strong> on any build on the site. In game, run:
                  <div className="modpage__step-cmd">
                    <CopyCommand command="/wand" />
                  </div>
                  Right-click the ground where you want it and punch the air to build.
                </li>
              </ol>
              <p className="modpage__note">
                Pairing links that world to your account, so nobody else can send builds to it.
              </p>
            </div>
          )}

          {activeTab === 'dedicated' && (
            <div
              id="panel-dedicated"
              role="tabpanel"
              aria-labelledby="tab-dedicated"
              className="modpage__tabpanel"
            >
              <ol className="modpage__steps">
                <li>
                  <strong>Vanilla clients can connect without the mod.</strong> Install Fabric and
                  the CraftMagic mod jar into the server’s <code>mods/</code> directory. Players
                  joining the dedicated server do <strong>not</strong> need the mod or Fabric
                  installed on their clients.
                </li>
                <li>
                  <strong>Operator level 2 requirement.</strong> Because pairing enables placing
                  blocks anywhere in the world, running <CopyCommand command="/craftmagic pair <code>" />{' '}
                  and mod configuration commands requires Minecraft <strong>OP level 2</strong> or
                  higher. Server administrators can grant this in console using <code>op &lt;player&gt;</code>.
                </li>
                <li>
                  <strong>No open incoming ports needed.</strong> The mod dials outbound directly to
                  CraftMagic over a secure WebSocket connection. You do not need to configure port
                  forwarding, open firewall ports, or expose network endpoints.
                </li>
              </ol>
              <p className="modpage__note">
                Once paired by a server operator, any permitted player can place authorized builds in
                designated areas.
              </p>
            </div>
          )}

          {activeTab === 'lan' && (
            <div
              id="panel-lan"
              role="tabpanel"
              aria-labelledby="tab-lan"
              className="modpage__tabpanel"
            >
              <ol className="modpage__steps">
                <li>
                  <strong>Host owns the pairing.</strong> The player hosting the world via “Open to
                  LAN” links the session to their CraftMagic account. Only the host can run the
                  initial pairing command <CopyCommand command="/craftmagic pair <code>" />.
                </li>
                <li>
                  <strong>Guests need OP permissions from the host.</strong> Friends joining the
                  LAN world do not need to pair, but they require operator permission (level 2) to
                  run wand and placement commands. The host can grant this by typing{' '}
                  <code>/op &lt;player&gt;</code> in chat.
                </li>
                <li>
                  <strong>Shared building.</strong> When a build is sent to the LAN world, all
                  connected players can see the live outline preview and watch the bot construct the
                  build in real time.
                </li>
              </ol>
            </div>
          )}
        </section>

        {/* Commands list with click-to-copy */}
        <section className="panel">
          <h2>Commands</h2>
          <dl className="modpage__commands">
            <dt>
              <CopyCommand command="/craftmagic pair <code>" />
            </dt>
            <dd>Link this world to your account.</dd>

            <dt>
              <CopyCommand command="/wand" />
            </dt>
            <dd>
              Get the magic wand. <strong>Right-click</strong> marks the spot,{' '}
              <strong>sneak + right-click</strong> turns the build 90°, and{' '}
              <strong>punching the air</strong> builds it. Nothing is placed until you punch, so
              you can re-aim as many times as you like.
            </dd>

            <dt>
              <CopyCommand command="/craftmagic build" />
            </dt>
            <dd>Place the pending build where you are standing, without the wand.</dd>

            <dt>
              <CopyCommand command="/craftmagic place <x> <y> <z>" />
            </dt>
            <dd>Place it at exact coordinates instead.</dd>

            <dt>
              <CopyCommand command="/craftmagic pause" />
            </dt>
            <dd>Pause an active build in progress in Minecraft.</dd>

            <dt>
              <CopyCommand command="/craftmagic resume" />
            </dt>
            <dd>Resume a paused build in Minecraft.</dd>

            <dt>
              <CopyCommand command="/craftmagic undo" />
            </dt>
            <dd>Tear down and dismantle the placed blocks from the last build.</dd>

            <dt>
              <CopyCommand command="/craftmagic offset <dy>" />
            </dt>
            <dd>Adjust the vertical placement offset in blocks.</dd>

            <dt>
              <CopyCommand command="/craftmagic speed <n>" />
            </dt>
            <dd>Blocks placed per second. <code>0</code> places everything at once.</dd>

            <dt>
              <CopyCommand command="/craftmagic status" />
            </dt>
            <dd>Show whether this world is paired, and to which server.</dd>

            <dt>
              <CopyCommand command="/craftmagic unpair" />
            </dt>
            <dd>Forget the pairing and disconnect.</dd>
          </dl>
          <p className="modpage__note">
            In your own singleplayer world these all work as-is — you do <strong>not</strong> need
            to enable cheats. On a dedicated server, pairing and settings need operator permission.
            On LAN, the host can pair it, and guests need <code>/op</code> first.
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

            <dt>
              “Incorrect argument for command” on <code>pair</code>
            </dt>
            <dd>
              On a dedicated server you need operator permission — Minecraft hides subcommands you
              can’t use, and the error points at the word instead of explaining why. Ask an admin
              for <code>/op</code>. In your own world this should just work; if it doesn’t, you’re
              on an old build of the mod, so download it again.
            </dd>

            <dt>Pairing says the code is invalid</dt>
            <dd>Codes last ten minutes and work once. Generate a fresh one.</dd>

            <dt>The world never comes online</dt>
            <dd>
              The mod dials out to this site over WebSocket. A firewall that blocks outbound
              connections will stop it; run <CopyCommand command="/craftmagic status" /> to see
              which server it is trying.
            </dd>

            <dt>Blocks stop partway through</dt>
            <dd>
              Building pauses in unloaded chunks. Stay near the site, or lower{' '}
              <CopyCommand command="/craftmagic speed <n>" /> so it keeps up.
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}
