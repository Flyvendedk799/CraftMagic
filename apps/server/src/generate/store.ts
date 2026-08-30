/**
 * In-flight generations and their progress streams.
 *
 * A generation takes 15–60 seconds, which is far too long to hold an HTTP request open and
 * far too long to show a bare spinner. So the POST returns immediately with an id and the
 * work continues in the background, with progress delivered over SSE.
 *
 * Events are buffered per generation and replayed to a subscriber on connect. Without that,
 * the gap between "POST returned" and "browser opened the event stream" silently swallows
 * the first events — and on a fast generation, potentially all of them.
 *
 * State lives in memory deliberately: until builds are persisted (M5) a generation is only
 * meaningful to the browser that asked for it, and a restart losing an in-flight generation
 * is the correct behaviour rather than a bug to design around.
 */

import { randomUUID } from 'node:crypto';
import type { BuildProgram, ExpandIssue } from '@craftmagic/core';
import type { ProgressEvent } from './pipeline.js';

export type GenerationEvent =
	| {
			type: 'progress';
			stage: ProgressEvent['stage'];
			components?: number;
			blockCount?: number;
			/** The streaming preview program — see `ProgressEvent`. Additive; old clients ignore it. */
			partial?: BuildProgram;
	  }
	| {
			type: 'done';
			program: BuildProgram;
			blockCount: number;
			status: 'succeeded' | 'succeeded_with_omissions';
			repaired: boolean;
			issues: ExpandIssue[];
			costUsd: number;
			spentThisMonthUsd: number;
			remainingUsd: number;
	  }
	| { type: 'error'; message: string };

type Subscriber = (event: GenerationEvent) => void;

interface Generation {
	id: string;
	prompt: string;
	createdAt: number;
	events: GenerationEvent[];
	finished: boolean;
	subscribers: Set<Subscriber>;
}

/** Generations older than this are dropped, so a long-lived server does not accumulate them. */
const RETENTION_MS = 30 * 60 * 1000;

export class GenerationStore {
	private readonly generations = new Map<string, Generation>();

	create(prompt: string): Generation {
		this.evictOld();
		const generation: Generation = {
			id: randomUUID(),
			prompt,
			createdAt: Date.now(),
			events: [],
			finished: false,
			subscribers: new Set(),
		};
		this.generations.set(generation.id, generation);
		return generation;
	}

	get(id: string): Generation | undefined {
		return this.generations.get(id);
	}

	emit(id: string, event: GenerationEvent): void {
		const generation = this.generations.get(id);
		if (!generation || generation.finished) return;

		// A preview replaces the previous preview in the replay buffer rather than joining
		// it. Every partial supersedes the one before, and a long generation would otherwise
		// buffer dozens of near-complete programs — the one unbounded-memory path in here.
		if (event.type === 'progress' && event.partial) {
			const prior = generation.events.findIndex(
				(buffered) => buffered.type === 'progress' && buffered.partial !== undefined,
			);
			if (prior >= 0) generation.events.splice(prior, 1);
		}

		generation.events.push(event);
		if (event.type === 'done' || event.type === 'error') generation.finished = true;

		for (const subscriber of generation.subscribers) {
			try {
				subscriber(event);
			} catch {
				// A dead connection must not stop the others from being notified.
			}
		}
	}

	/**
	 * Subscribe, receiving every event so far first.
	 *
	 * Returns an unsubscribe function, and a flag saying whether the generation is already
	 * finished — the caller uses that to close the stream immediately rather than holding a
	 * connection open for a generation that ended before the browser connected.
	 */
	subscribe(id: string, subscriber: Subscriber): { unsubscribe: () => void; finished: boolean } | undefined {
		const generation = this.generations.get(id);
		if (!generation) return undefined;

		for (const event of generation.events) subscriber(event);
		if (generation.finished) return { unsubscribe: () => {}, finished: true };

		generation.subscribers.add(subscriber);
		return {
			unsubscribe: () => generation.subscribers.delete(subscriber),
			finished: false,
		};
	}

	private evictOld(): void {
		const cutoff = Date.now() - RETENTION_MS;
		for (const [id, generation] of this.generations) {
			if (generation.createdAt < cutoff && generation.subscribers.size === 0) {
				this.generations.delete(id);
			}
		}
	}
}
