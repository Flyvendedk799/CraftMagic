-- What a saved build *is*, now that there is more than one thing it can be.
--
-- CraftMagic is becoming three tiers: a Build is a structure, Architecture is its interior —
-- rooms, furniture, storeys — and the coming World mode places saved builds as components.
-- Nothing in this table has ever distinguished the first two, and that is a real bug and not
-- a tidiness complaint: a component shelf cannot filter what it cannot tell apart, so the
-- shelf offering "things to place in a world" would offer interiors, and a world would be
-- offered back as a thing to put inside a world.
--
-- Exactly two values, and no third for worlds. A world has no voxels and `voxels` is NOT
-- NULL, so a world is not a row this table can hold at all; it gets its own table when the
-- mode lands. Widening the CHECK to make it fit here would buy a column of nulls and a
-- NOT NULL constraint that has to be lied about.
ALTER TABLE builds ADD COLUMN kind text NOT NULL DEFAULT 'structure'
  CHECK (kind IN ('structure','interior'));

-- Backfill: the plan column is precisely the signal that a build was compiled
-- from the floorplan tool rather than placed block by block.
UPDATE builds SET kind = 'interior' WHERE plan IS NOT NULL;
