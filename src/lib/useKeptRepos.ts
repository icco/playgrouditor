import { useEffect, useState } from 'react';
import { KeptRepo, listKeptRepos, subscribeKeptRepos } from './offlineRepos';

export function useKeptRepos(): KeptRepo[] {
  const [repos, setRepos] = useState<KeptRepo[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      listKeptRepos()
        .then(r => {
          if (active) setRepos(r);
        })
        .catch((e: unknown) => console.warn('Could not read offline repos', e));
    };
    load();
    const unsubscribe = subscribeKeptRepos(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return repos;
}
