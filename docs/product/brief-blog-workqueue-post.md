# Brief — Blog post #2 : Work Queue (Competing Consumers)

> Statut : brief validé (brainstorm du 2026-07-31). Branche : `blog/work-queue-post`.
> Post #2 de la série définie dans [`brief-blog-series.md`](brief-blog-series.md) — toutes les
> contraintes de série (dossier par post, permaliens pinnés, samples 6 langages, images statiques,
> pas de techno annexe dans la prose) s'appliquent inchangées.
> Prochaine étape : `/spec`. **Ne rien rédiger/implémenter avant.**

## Problème

Le post #1 (DLQ) a montré qu'un message empoisonné ne doit pas bloquer une file. Il ne dit rien du
**volume** : un seul consumer sur un stream est un goulot, et le dev qui découvre les consumer
groups ignore (a) que la répartition est gratuite — 1 groupe, N consumers, chaque job livré à un
seul worker — et (b) comment observer qu'il est en retard. Ce post #2 comble ce trou en réutilisant
**la même fonction Lua** que le post #1 (`read_claim_or_dlq`) : aucune nouvelle primitive Redis à
apprendre, tout le contenu neuf est dans la topologie et le dimensionnement.

## Utilisateurs & usage principal

- **Lecteur primaire** : dev backend ayant lu le post #1 → repart capable d'ajouter des workers et
  de mesurer l'effet, et sait que `BLOCK` est le mode de lecture de production.
- **Lecteur secondaire (architecte)** : trouve les garanties énoncées explicitement — at-least-once,
  **un job traité par un seul worker**, aucun job perdu si un worker meurt, retry borné puis DLQ.
- **Usage** : lecture ~7 min → rejouer soi-même en `redis-cli` dans deux terminaux, sans toucher à
  la démo Spring/Angular.

## Goals

### Le post

- `blog/work-queue-redis-streams/index.md` — anglais, **1600-1900 mots** de prose (un peu plus que
  le post #1 : la section poll/`BLOCK` est nouvelle).
- **Angle : scaling / débit.** Un seul levier est déroulé — **augmenter le nombre de consumers** ;
  les autres (batching `COUNT` + `XACK` groupés, rétention `MAXLEN`/`XTRIM`) sont **évoqués en une
  phrase chacun**, pas déroulés. Budget oblige.
- **Répartition rendue visible de deux façons** : `XLEN jobs.done.worker-N` (effet visuel immédiat,
  comme la démo — présenté comme un instrument de mesure, pas comme une pratique de production),
  puis `XINFO CONSUMERS` / `XPENDING` / `lag` + `entries-read` du groupe comme la vraie méthode
  d'observation.
- **Reprise après crash : section courte**, via `read_claim_or_dlq` uniquement — un worker meurt
  avec un job dans son PEL, l'étape `CLAIM` le redonne au premier worker qui poll après `minIdle`.
  Pas d'`XAUTOCLAIM` (mentionné nulle part : il vit dans d'autres patterns du repo).
- **DLQ : 2-3 phrases** de rappel du concept + lien vers le post #1. Budget dur, aucune
  re-explication du claim ni du compteur de livraisons.
- **Poll vs `BLOCK` assumé** : le poll 100 ms de `WorkQueueService` est présenté comme un choix de
  visualisation de la démo ; la prose recommande `XREADGROUP … BLOCK` et explique le **split de
  production** — une fonction Lua **ne peut pas bloquer**, donc le chemin chaud est un
  `XREADGROUP … BLOCK` et le rattrapage (claim des idle + routage DLQ) est un `FCALL` périodique.
  C'est la forme réelle du pattern #12 du repo (worker + sweeper séparé) → lien de crédibilité.
- **Piège à nommer explicitement** : retirer un worker ne doit **pas** faire
  `XGROUP DELCONSUMER` tant qu'il a des entrées en PEL (elles sortent du PEL → jobs perdus). On
  arrête la boucle et on laisse le `CLAIM` récupérer.
- 1 schéma logique (source `.excalidraw` + PNG exporté, alt text obligatoire) : producer → stream →
  1 groupe → N workers → done streams, flèche DLQ en pointillés renvoyant au post #1.
- **6 samples exécutables** (`java`, `python`, `node`, `go`, `csharp`, `rust`) en forme « split
  prod » : un seul processus mono-thread, boucle `XREADGROUP … BLOCK 1000` + `FCALL
  read_claim_or_dlq` toutes les ~2 s, nom du consumer en argument, ~70-80 lignes. Lancer deux fois
  dans deux terminaux = voir la répartition. Mono-thread par choix : portable et testable
  identiquement dans les 6 langages.
- **Clés = celles de la démo, à l'identique** : `jobs.imageProcessing.v1`, groupe `jobs-group`,
  DLQ `jobs.imageProcessing.v1:dlq`, done streams `jobs.done.worker-N`, `count=1`, `maxDeliver=2`,
  `minIdle=100` ms.
- `samples/setup.sh` idempotent + `verify.sh` sur le modèle du post #1 : rejeu verbatim des blocs
  `redis-cli`, exécution réelle des 6 samples, word count, link check, grep techno interdite.
- Tag de publication **`blog-workqueue-v1`**, dossier `blog/work-queue-redis-streams/`
  (convention `PUBLISHING.md`).

### La démo (décision de l'auteur du 2026-07-31 — élargit le périmètre)

- **Nombre de workers pilotable à chaud** depuis la page `/work-queue` : ajouter / retirer un worker
  et voir la charge se redistribuer. Sans ça, le post parle de scaling sur une démo figée à 4.
- Implique : `NUM_WORKERS` → borné dynamique (min/max à fixer en spec), endpoints REST
  ajout/retrait, `getStreamNames()` et `clearAllStreams()` dé-hardcodés, `startMonitoring` du
  nouveau done stream, page Angular avec un nombre de panneaux dynamique, spec + tests.
- Retrait d'un worker = **arrêt de la boucle sans `DELCONSUMER`**, en deux saveurs (spec du slice A) :
  *graceful* (le job en cours se termine) et *kill* (interruption → le job reste en PEL et est repris
  par un autre worker) → cette seconde saveur alimente directement la section « reprise après crash »
  du post, et la rend démontrable dans l'UI en plus du CLI.

### Cohérence

- **Audit bloquant avant rédaction** : `lua/stream_utils.lua` ↔ `WorkQueueService` ↔
  `docs/specs/work-queue.md` ↔ page `/work-queue` ↔ `README.md`.
- Écart déjà identifié : `docs/specs/work-queue.md` dit groupe `mygroup`, le code dit `jobs-group` ;
  le `Inferred — verify` sur le nombre de workers doit être levé. **Le code fait foi** ; la spec est
  corrigée. Tout autre écart est listé à l'auteur avant action.

## Non-goals

- **Pas de chiffres mesurés**, pas de micro-bench, aucune promesse de performance (règle de série).
- Pas d'`XAUTOCLAIM`, pas de partitionnement/sharding, pas de files à priorités.
- Pas de WebSocket / Angular / SockJS / Spring dans la prose du post (règle de série).
- Pas de deep-dive production (HA, cluster, ACL, TLS, sizing).
- **Version française : slice suivant**, une fois l'anglais validé (2 PRs, comme le post #1).
- Les 10 autres patterns.

## Contraintes clés

- **Redis 8.4+** requis (`XREADGROUP … CLAIM`, utilisé par `read_claim_or_dlq`) — annoncé comme
  8.4+ et non 8.8+ car ce post n'utilise **pas** `XNACK` ; le walkthrough épingle malgré tout
  `redis:8.8-alpine`, baseline du projet.
- Aucun nouveau code Lua : `read_claim_or_dlq` est réutilisé tel quel.
- Permaliens absolus pinnés sur `blog-workqueue-v1` → **404 jusqu'au push du tag depuis le host**
  par l'auteur (`blog/PUBLISHING.md`).
- API clientes des 6 samples vérifiées via **Context7** à l'implémentation, jamais de mémoire
  d'entraînement.
- Markdown portable + PNG (CMS blog Redis).
- Le changement de démo se construit et se teste **dans la VM** ; aucun push/PR depuis la VM.

## Top risques & questions ouvertes

1. **Le split `BLOCK` + sweeper est la partie neuve et la plus facile à rater.** Deux chemins de
   lecture sur le même nom de consumer, et `read_claim_or_dlq` renvoie *aussi* des messages neufs
   (son étape 3 est un `XREADGROUP`). Les samples doivent router les deux sources vers le même
   handler, sinon un job est lu et jamais `XACK`é. Mitigation : exécuter réellement les 6 samples,
   deux instances en parallèle, et vérifier `XPENDING` vide en fin de scénario.
2. **Redite avec le post #1** — même Lua, même DLQ. Si la prose re-explique le claim, le post perd
   sa raison d'être. Mitigation : budget dur de 2-3 phrases sur la DLQ + renvoi systématique.
3. **Le changement de démo peut déborder** (backend + Angular + spec + tests, et la page doit gérer
   un nombre de done streams variable). Mitigation : c'est un **slice séparé, livré et validé avant**
   la rédaction du post ; si ça dérape, le post peut être écrit sur la démo figée à 4 workers.
4. **Question ouverte pour la spec** : bornes du nombre de workers (min 0 ou 1 ? max 8 ?), et
   faut-il persister le nombre choisi entre redémarrages (a priori non — état en mémoire).

## Slices

- **Slice A — démo : workers pilotables.** Spec écrite : [`work-queue-dynamic-workers.md`](../specs/work-queue-dynamic-workers.md).
  Audit de cohérence → docs corrigées → endpoints add/remove/kill worker + dé-hardcodage des done
  streams → page `/work-queue` dynamique → diagramme mermaid corrigé → tests d'intégration
  (un worker tué avec un job en PEL → le job est repris, pas perdu).
- **Slice B — le post anglais.** `setup.sh` → walkthrough `redis-cli` vérifié → 6 samples exécutés
  → schéma → prose 1600-1900 mots → `verify.sh` vert.
- **Slice C — version française** (`index.fr.md`), après validation de l'anglais.

## Next step

Lancer `/spec` sur le **slice A** → `docs/specs/work-queue-dynamic-workers.md`, puis `/spec` sur le
slice B → `docs/specs/blog-workqueue-post.md`.
