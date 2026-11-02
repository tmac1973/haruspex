/**
 * Every specialist kind, registered by importing its module. Import this for
 * its side effect from the places that need the kinds: the tool and the
 * settings UI, never from the registry or entry helpers (that would be a
 * cycle).
 */
import '#lib/specialists/kinds/text.ts';
import '#lib/specialists/kinds/glb.ts';
