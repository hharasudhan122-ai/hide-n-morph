import { useEffect, useState } from 'react';
import type { MapManifest } from '../types/game';

interface UseMapManifestResult {
  manifest: MapManifest | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches public/maps/<mapId>/manifest.json and runs the validation rules
 * from manifest-schema.md before handing it to the scene. Failing loudly
 * here (in dev) is much easier to debug than a silent blank scene.
 */
export function useMapManifest(mapId: string): UseMapManifestResult {
  const [manifest, setManifest] = useState<MapManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/maps/${mapId}/manifest.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
        return res.json();
      })
      .then((data: MapManifest) => {
        if (cancelled) return;
        const problems = validateManifest(data);
        if (problems.length > 0) {
          console.warn(`[manifest] ${mapId} has issues:\n` + problems.join('\n'));
        }
        setManifest(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? 'unknown manifest error');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mapId]);

  return { manifest, loading, error };
}

/** Mirrors the validation rules in manifest-schema.md. Returns a list of
 * human-readable problems; does not throw, since some issues (e.g. a thin
 * group) are warnings, not hard failures. */
function validateManifest(m: MapManifest): string[] {
  const problems: string[] = [];

  const seenIds = new Set<string>();
  const groupCounts = new Map<string, number>();

  for (const prop of m.morphables) {
    if (seenIds.has(prop.id)) {
      problems.push(`duplicate morphable id: ${prop.id}`);
    }
    seenIds.add(prop.id);
    groupCounts.set(prop.groupId, (groupCounts.get(prop.groupId) ?? 0) + 1);
  }

  for (const [groupId, count] of groupCounts) {
    if (count < 2) {
      problems.push(`group "${groupId}" has only ${count} member — morphing into it will be an instant tell`);
    }
  }

  const maxRoomSize = 4;
  if (m.spawns.hider.length < maxRoomSize - 1) {
    problems.push(
      `only ${m.spawns.hider.length} hider spawn points, but rooms support up to ${maxRoomSize - 1} hiders`
    );
  }
  if (m.spawns.seeker.length < 1) {
    problems.push('no seeker spawn points defined');
  }

  return problems;
}
