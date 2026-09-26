# Passages satellites au-dessus de chez vous

## Lancer le projet

Il faut servir les fichiers via un petit serveur local (le `fetch` vers CelesTrak/Nominatim est plus fiable ainsi qu'en ouvrant directement le fichier avec `file://`) :

```bash
cd dossier-du-projet
python3 -m http.server 8000
```

Puis ouvrez `http://localhost:8000/index.html` dans le navigateur.

Aucune clé API n'est nécessaire (CelesTrak, Nominatim et les tuiles Esri sont en accès libre).

## Comment ça marche

1. **Géocodage** : l'adresse est convertie en lat/lon via Nominatim (OpenStreetMap).
2. **Récupération des éléments orbitaux (TLE)** : plusieurs groupes CelesTrak sont combinés (`active`, `stations`, `tle-new`, + principaux nuages de débris) pour approcher un "catalogue complet". CelesTrak n'expose pas un flux unique et anonyme de la totalité du SATCAT (~30 000+ objets, y compris les tout derniers) — cette combinaison de groupes en est une approximation raisonnable sans compte Space-Track.
3. **Nationalité** : croisée depuis le SATCAT texte de CelesTrak (`pub/satcat.txt`), par numéro NORAD. Le champ n'existe pas toujours pour les objets les plus récents.
4. **Fonction** : classification heuristique par nom/groupe (communication, météo, navigation, débris, étage de fusée...) — CelesTrak ne fournit pas de champ "fonction" structuré pour tout le catalogue.
5. **Détection des passages** : dans un Web Worker, pour chaque satellite dont l'inclinaison permet d'atteindre votre latitude, la distance au centre du carré est échantillonnée sur toute la journée (SGP4 via `satellite.js`), puis affinée par recherche ternaire autour de chaque minimum local pour savoir si le passage entre vraiment dans le carré de 500m.
6. **Rare, et c'est normal** : le carré est petit. Certains jours il peut n'y avoir que quelques passages, ou aucun avec le mode "Actifs seulement". Le mode "Catalogue complet" en trouve davantage (débris inclus).

## Réglages disponibles dans l'interface

- **Étendue du catalogue** : Actifs seulement (rapide) vs Catalogue complet + débris (plus riche, plus lent au premier calcul).
- **Résolution de recherche** : contrôle le pas d'échantillonnage grossier avant raffinement (Rapide/Standard/Précis) — un compromis vitesse/risque de rater un passage très bref.

## Limites connues

- Pas d'authentification Space-Track : le catalogue est une approximation (~15-20k objets) plutôt que les ~30k+ officiels.
- La classification "fonction" est une heuristique, pas une base de données faisant autorité.
- Premier calcul potentiellement long (plusieurs dizaines de secondes) selon la machine et le mode choisi — une barre de progression l'indique.
