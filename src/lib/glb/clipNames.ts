/**
 * What a clip's name says about it when nothing else does: the motion checks
 * and the models spec both go by these.
 */

/** Clip names that loop unless the spec says otherwise. */
export const LOOPING_CLIP = /idle|walk|run|fly|hover|glide|soar|swim/i;
/** Clip names that may leave the floor unless the spec says otherwise. */
export const AIRBORNE_CLIP = /run|jog|sprint|gallop|jump|hop|leap|fly|hover|glide|soar|swim/i;
