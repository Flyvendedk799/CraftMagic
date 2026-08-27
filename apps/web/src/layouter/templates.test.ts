import { describe, expect, it } from 'vitest';
import { expand } from '@craftmagic/core';
import { compilePlan } from './compile.js';
import { TEMPLATES } from './templates.js';
import { validatePlan } from './validate.js';

describe('templates', () => {
  for (const template of TEMPLATES) {
    describe(template.name, () => {
      it('compiles and expands without an error', () => {
        const { program, warnings } = compilePlan(template.build());
        const result = expand(program);

        expect(warnings).toEqual([]);
        expect(result.errors).toEqual([]);
        // The empty site is the one that is meant to build nothing.
        if (template.id !== 'blank') expect(result.blockCount).toBeGreaterThan(0);
      });

      it('is a building someone can actually walk around', () => {
        // A starting point that opens with problems teaches the wrong lesson about what the
        // checks mean, so every template has to pass the same ones a hand-drawn plan does.
        const blocking = validatePlan(template.build()).issues.filter(
          (issue) => issue.level !== 'info',
        );

        expect(blocking.map((issue) => `${issue.code}: ${issue.message}`)).toEqual([]);
      });
    });
  }
});
