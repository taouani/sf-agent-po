# Atelier de cadrage : digitalisation du service après-vente maroquinerie

Maison Véronne, 22 octobre 2026, siège de Paris.

Présents : Claire Dumoulin (directrice service client), Antoine Leroy (responsable atelier de Pantin), Inès Haddad (DSI, chef de projet Salesforce), Marco Bellini (directeur des boutiques Europe), Julie Perrin (finance).

## Contexte

La Maison Véronne vend sa maroquinerie dans 31 boutiques en propre (France, Italie, Royaume-Uni, Suisse, Japon) et sur son site e-commerce. Elle reçoit environ 18 000 demandes de réparation par an : coutures, poignées, fermetures, remise en teinte, changement de doublure. Aujourd'hui, la boutique remplit un bon papier en trois exemplaires, l'article part à l'atelier de Pantin par transporteur, et le client appelle la boutique pour savoir où en est sa réparation. Le délai moyen est de 9 semaines et personne ne sait le mesurer précisément.

Salesforce est déjà utilisé : Service Cloud pour le service client (centre de contact de Paris, cas par email et téléphone) et Commerce Cloud pour le site. Les boutiques n'ont pas de licence aujourd'hui. Le système de caisse est Cegid ; l'ERP est SAP S/4HANA, qui porte les articles, les numéros de série et la facturation.

## Besoins exprimés

1. En boutique, le conseiller crée la demande de réparation sur iPad avec le client : photos de l'article, description du défaut, numéro de série (gravé sous la languette), preuve d'achat si elle existe.
2. Le conseiller donne un devis indicatif à partir d'une grille tarifaire par type de réparation. Les réparations sous garantie (2 ans, défaut de fabrication) sont gratuites ; l'atelier confirme la prise en garantie après expertise.
3. Le client reçoit un suivi à chaque étape (reçu en boutique, à l'atelier, en expertise, devis à valider, en réparation, prêt à retirer) par email ou SMS, et peut suivre sa demande depuis son compte sur le site.
4. Si le devis final dépasse le devis indicatif de plus de 20 %, le client doit l'accepter avant le début des travaux.
5. L'atelier de Pantin suit sa charge par artisan et par type de réparation, et voit les articles en attente de pièces.
6. Les articles en cuir exotique (crocodile, alligator, autruche, lézard) partent vers notre atelier spécialisé de Genève.
7. Indicateurs : délai moyen ramené à 5 semaines, 90 % des clients informés à chaque étape sans avoir à appeler, taux de réclamation sur réparation suivi chaque mois.

## Calendrier

Pilote dans les 8 boutiques françaises le 1er mars 2027, puis le reste de l'Europe en juin 2027.

## Points ouverts

- La grille tarifaire existe dans un fichier Excel tenu par l'atelier ; personne n'a dit qui la maintiendra.
- Les numéros de série antérieurs à 2015 ne sont pas dans SAP.
