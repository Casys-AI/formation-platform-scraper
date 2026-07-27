# Formation Platform Scraper

[English](README.md) · **Français**

Un scraper pour les formations en ligne hébergées sur [Teachizy](https://www.teachizy.fr/), le SaaS français d'hébergement de formations — organisé autour d'une idée unique : **le cours est dans la vidéo, pas dans la page**.

Ouvrez une leçon et lisez son HTML : un titre, quelques lignes, un lien ou deux. L'enseignement à proprement parler — la partie pour laquelle vous avez payé — est parlé, à l'intérieur d'une vidéo que le balisage ne fait que pointer. Un scraper qui ne lit que le texte revient avec la coquille et passe à côté du fond. Celui-ci va chercher la vidéo : chaque extrait, qu'il soit sur YouTube, Vimeo, en MP3 ou via une URL directe/S3, est téléchargé et transcrit avec Whisper, de sorte que le cours parlé devienne un texte indexable.

La deuxième idée, c'est la structure. Une formation est un arbre — chapitres, leçons, quiz, ressources jointes — et le scraper le parcourt intégralement, en exportant un fichier Markdown par leçon, avec la transcription, les liens qualifiés et les métadonnées intégrés.

La troisième, c'est ce qui vient après l'extraction. Un analyseur pédagogique lit l'ensemble du corpus et construit un **graphe de connaissances** : quels outils et concepts sont enseignés, lesquels sont pratiqués plutôt que simplement mentionnés, et comment ils progressent chapitre après chapitre — prêt pour l'indexation ou le RAG.

Il est **spécialisé, pas générique** : il connaît Teachizy — sa connexion, la structure de son `/mon-espace`, la mécanique de ses leçons et de ses quiz — et cette connaissance fine est précisément ce qui fait sa valeur.

## Pourquoi ça peut vous intéresser

- **Il va chercher la vidéo.** Le fond d'un cours est parlé, pas écrit. Whisper transcrit chaque extrait embarqué pour que le contenu réel de la leçon devienne un texte que vous pouvez chercher, indexer et fournir à un modèle — là où la page ne vous donnait qu'un titre.
- **Un graphe de connaissances, pas un dossier de fichiers.** Au-delà de l'extraction brute, il cartographie ce qu'une formation enseigne réellement : outils utilisés vs. simplement mentionnés, première apparition par chapitre, densité conceptuelle, une matrice technologie × chapitre — exportée en HTML, Markdown et PDF.
- **Une connexion d'apprenant, pas d'administrateur.** L'authentification est une simple connexion directe sur le domaine propre de l'école. Pas de back-office de plateforme, pas de droits d'administration — les identifiants que vous utilisez pour suivre le cours sont les seuls dont il a besoin.
- **Reprise intégrée.** Les téléchargements et les transcriptions suivent leur propre état sur le disque ; interrompez une extraction de 200 leçons et relancez la même commande — elle reprend là où elle s'était arrêtée.
- **Transparent sur le coût.** Les médias et la transcription sont les étapes coûteuses ; un mode dry-run les compte et estime la facture avant qu'un seul appel API ne soit payé.

## Prérequis

- Node.js 18+ (v22 recommandée)
- pnpm ou npm
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) et `ffmpeg`/`ffprobe` dans votre `PATH` — voir [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) pour les instructions d'installation et un script de vérification des dépendances
- Un compte donnant accès à la formation que vous souhaitez scraper
- Une clé API OpenAI (transcription Whisper + mise en forme par IA)

## Installation

```bash
# Installer les dépendances
pnpm install   # ou : npm install

# Télécharger le Chromium piloté par Playwright
npx playwright install chromium
```

Le scraper pilote Chromium en interne via [Playwright](https://playwright.dev/) — aucun serveur ni étape de compilation séparés.

## Configuration

### Variables d'environnement

Copiez `.env.example` vers `.env` et renseignez vos identifiants :

```bash
cp .env.example .env
```

```bash
# Required
FORMATION_EMAIL=your.email@example.com
FORMATION_PASSWORD=your_password
FORMATION_URL=https://formations.example.academy/mon-espace/formations/my-course
OPENAI_API_KEY=sk-proj-xxx

# Optional
TAVILY_API_KEY=             # Link qualification & broken-link replacement search
```

Voir [`.env.example`](.env.example) pour la liste complète, y compris les options de journalisation et de comportement à l'exécution (`PLAYWRIGHT_HEADLESS`, `DELAY_BETWEEN_PAGES_MS`, `DOWNLOAD_MEDIA`, `TRANSCRIBE_MEDIA`). Tout le reste du comportement d'extraction se configure dans `extraction-config.json`.

### Configuration de l'extraction

La commande `extract` lit `extraction-config.json` à la racine du dépôt (ignoré par git, puisqu'il embarque l'URL de votre formation). Partez de l'exemple :

```bash
cp extraction-config.example.json extraction-config.json
```

```json
{
  "$schema": "./extraction-config.schema.json",
  "formationUrl": "https://formations.example.academy/mon-espace/formations/my-course",
  "mode": "chapters",
  "chapters": [1, 2, 3],
  "rateLimit": { "delayMs": 1000, "enableRateLimit": true },
  "media": { "skipMedia": false, "skipTranscribe": false, "resumeMode": true }
}
```

`extraction-config.schema.json` documente chaque champ (modes : `chapters`, `types`, `all`, `specific-lessons` ; options média, mise en forme, anti-détection et proxy) et est câblé comme `$schema` pour l'autocomplétion dans l'éditeur. De même :

- `dry-run-config.example.json` → à copier vers `dry-run-config.json` pour une exécution d'estimation de coût (compte les médias, estime le coût de transcription, sans téléchargement)
- `link-check-config.example.json` → à copier vers `link-check-config.json` pour la commande `check-links`

## Utilisation (CLI)

Le CLI est `tsx src/cli/cli.ts`, exposé via des scripts npm :

```bash
# Discover and save the course structure
pnpm discover

# List available chapters from the saved structure
pnpm list-chapters

# Interactively select which chapters to extract (updates extraction-config.json)
pnpm select-chapters

# Run extraction based on extraction-config.json
pnpm extract

# Estimate cost/media count without downloading (dry-run-config.json)
pnpm dry-run

# Check health of all external links in extracted lesson content
pnpm check-links

# Generate a pedagogical knowledge graph from extracted lessons
pnpm knowledge-graph   # alias: pnpm kg

# Generate an extraction status report (output/{course-slug}/REPORT.md)
pnpm report
```

Ou utilisez le menu interactif en lançant le CLI sans argument :

```bash
pnpm start
```

## Contournement de la détection de bot YouTube (optionnel)

**Nécessaire si vous extrayez des vidéos YouTube depuis un serveur en datacenter** (AWS, OVH, Oracle, etc.) — depuis décembre 2024, YouTube bloque les requêtes provenant d'IP de datacenter avec le message `Sign in to confirm you're not a bot`.

### Configuration rapide

**Sur votre machine locale (Windows/Mac/Linux) :**

1. **Installer Privoxy** (une seule fois) :
   - Windows : https://www.privoxy.org/sf-download-mirror/Win32/
   - Mac : `brew install privoxy && brew services start privoxy`
   - Linux : `sudo apt install privoxy && sudo systemctl start privoxy`

2. **Configurer un tunnel SSH** (une seule fois), dans `~/.ssh/config` :
   ```
   Host your-server
     HostName YOUR_SERVER_IP
     User ubuntu
     IdentityFile ~/.ssh/your_key
     RemoteForward 9090 127.0.0.1:8118  # Use 127.0.0.1, not localhost
   ```

3. **Ouvrir le tunnel avant l'extraction** (à chaque fois) : `ssh -N your-server` — laissez le terminal ouvert pendant toute la durée de l'extraction.

4. **Activer le proxy** dans `extraction-config.json` :
   ```json
   { "proxy": { "enabled": true, "url": "http://127.0.0.1:9090" } }
   ```

5. **Lancer l'extraction** sur le serveur comme d'habitude.

### Comment ça marche

```
Serveur (IP datacenter) → tunnel SSH → Votre machine locale (IP résidentielle) → YouTube ✅
```

Les requêtes passent par votre connexion FAI résidentielle, contournant ainsi la détection de bot. Vimeo, MP3 et les vidéos hébergées en direct/S3 fonctionnent sans proxy.

### Dépannage

- **« Remote end closed connection without response »** — utilisez `127.0.0.1:8118`, et non `localhost:8118`, dans `RemoteForward` (IPv4 vs IPv6).
- **« Connection refused »** — vérifiez que Privoxy tourne (`curl --proxy http://127.0.0.1:8118 https://www.google.com`) et que le tunnel est ouvert.

## Structure de sortie

```
output/
└── my-course/
    ├── course-structure.json
    ├── REPORT.md
    ├── chapter-01/
    │   ├── lesson-01-example-lesson.md
    │   ├── lesson-01-example-lesson.json
    │   └── ...
    └── chapter-02/
        └── ...

media/
└── my-course/
    └── chapter-01/
        ├── lesson-01-audio.mp3
        └── ...
```

### Format Markdown

```markdown
---
title: "Example Lesson Title"
chapter: 1
chapter_title: "Getting Started"
lesson_id: "1021159"
media:
  - type: youtube
    video_id: "dQw4w9WgXcQ"
    transcription_language: "fr"
links:
  - title: "Reference Guide"
    url: "https://..."
    summary: "..."
    quality_score: 0.92
---

# Example Lesson Title

[Main content]

## Video transcription

[Whisper transcription]

## Resources

### Reference Guide
**Quality:** 92%

[link summary]
```

## Point de contrôle et reprise

Les téléchargements de médias et les transcriptions suivent leur propre statut d'achèvement sur le disque. Relancer `pnpm extract` avec `media.resumeMode: true` (la valeur par défaut dans la configuration d'exemple) ignore les leçons et médias déjà traités avec succès — interrompre une extraction ne présente aucun risque, il suffit de relancer la même commande. Pour forcer un nouveau traitement, supprimez le sous-dossier `output/`/`media/` concerné ou définissez `media.resumeMode: false`.

## Développement

```bash
# Watch mode
pnpm dev

# Type check
npx tsc --noEmit
```

## Dépannage

- **« Browser launch failed » / navigateur manquant** — téléchargez Chromium : `npx playwright install chromium`.
- **Échec de l'authentification** — vérifiez `FORMATION_EMAIL`/`FORMATION_PASSWORD` dans `.env` ; lancez avec `PLAYWRIGHT_HEADLESS=false` pour observer le navigateur.
- **Limite de débit de l'API Whisper** — augmentez `DELAY_BETWEEN_PAGES_MS`, ou traitez par lots et reprenez plus tard.

## Licence

MIT — voir [`LICENSE`](LICENSE).
