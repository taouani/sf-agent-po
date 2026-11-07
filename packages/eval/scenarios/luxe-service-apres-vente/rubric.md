# Service après-vente maroquinerie : grille d'évaluation

Cette grille sert à juger le travail des agents pour ce scénario, à la main ou avec un modèle juge. Chaque ligne vaut un point. Le scénario n'a ni métadonnées ni documents d'org, utilise le modèle sectoriel `luxury`, et est en français. Il contient deux pièges : l'email de la direction des boutiques réduit le périmètre de l'atelier de cadrage, et les exigences juridiques (CITES, données de santé) demandent des contrôles dans l'outil, pas des consignes.

## Conception générale (sa_high_level_design)

- [ ] Le document est rédigé en français.
- [ ] Indique que l'org existante n'est connue que par le compte rendu (Service Cloud, Commerce Cloud, pas de métadonnées) et n'invente pas de composants existants.
- [ ] Suit l'email de la direction des boutiques plutôt que l'atelier : pilote limité aux 8 boutiques françaises et à Pantin, sans cuir exotique, sans paiement dans Salesforce ni suivi depuis le compte client ; le conflit est noté.
- [ ] Modélise la demande de réparation (par exemple Case ou Work Order avec l'article, le numéro de série, les photos, le statut, le devis) et ses étapes de suivi, en justifiant le choix.
- [ ] Garde SAP comme référence des articles et numéros de série et Cegid pour l'encaissement, et décrit l'intégration (motif et mécanisme) dont la récupération du montant validé par la caisse.
- [ ] Gère la garantie de 2 ans et la confirmation par l'atelier après expertise, et l'acceptation obligatoire du client quand le devis final dépasse le devis indicatif de plus de 20 %.
- [ ] Envoie les notifications de suivi par email et SMS comme messages de service, sans contenu marketing, et le dit explicitement.
- [ ] Empêche les données de santé dans les notes de réparation par un contrôle technique (champs structurés, validation ou détection), pas seulement une consigne.
- [ ] Limite les photos à l'article et prévoit leur suppression 12 mois après la clôture, avec un traitement planifié.
- [ ] Traite la CITES pour la phase 2 : blocage de l'expédition sans certificat validé par la douane, flux inverse pour la Suisse, refus de prise en charge au Japon pour les articles exotiques.
- [ ] Couvre le suivi de charge de l'atelier par artisan et par type de réparation et les articles en attente de pièces.
- [ ] Propose un type de licence pour les conseillers en boutique (plus légère que Service Cloud complet, ou justifie le contraire) et laisse l'estimation de coût en question ouverte.
- [ ] Prévoit le cas des numéros de série antérieurs à 2015 absents de SAP.
- [ ] Cite les identifiants des documents sources et liste les questions ouvertes avec un responsable (grille tarifaire, licences, procédure CITES).

## Backlog (po_backlog)

- [ ] Le backlog est rédigé en français.
- [ ] Couvre le pilote seulement (boutiques françaises, Pantin) et laisse hors périmètre les cuirs exotiques, le paiement en ligne et le suivi depuis le compte client, en disant pourquoi.
- [ ] Les stories couvrent la création de la demande en boutique avec photos, le devis indicatif, l'expertise et la garantie, l'acceptation du devis au-delà de 20 %, les notifications de suivi, la charge de l'atelier et le retrait en boutique avec encaissement en caisse.
- [ ] Les exigences juridiques applicables au pilote (données de santé, photos et suppression à 12 mois, notifications sans marketing) sont tracées vers au moins une story ou un critère d'acceptation.
- [ ] Les personas sont précis (Conseiller de vente, Artisan de l'atelier, Responsable atelier, Client), pas « utilisateur ».
- [ ] Les critères d'acceptation sont en Given/When/Then (ou Étant donné/Quand/Alors) et couvrent les cas d'erreur (devis refusé, numéro de série introuvable, note contenant une donnée de santé).
- [ ] Les indicateurs (délai de 5 semaines, 90 % de clients informés, taux de réclamation) deviennent des rapports, tableaux de bord ou critères d'acceptation.
- [ ] Un spike ou une question ouverte couvre l'intégration SAP ou Cegid, ou la reprise de la grille tarifaire.
- [ ] `backlog_save` ne signale aucune erreur.
