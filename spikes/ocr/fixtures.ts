// Test images for the OCR redaction spike, with the sensitive strings each one contains.
// make-fixtures.ts renders them once; the PNGs are committed so every OS reads the same pixels.

export interface Fixture {
  file: string;
  lang: 'eng' | 'fra' | 'eng+chi_sim';
  fontSize: number;
  font: string;
  lines: string[];
  sensitive: string[]; // must not be readable after redaction
}

export const FIXTURES: Fixture[] = [
  {
    file: 'en-contact.png',
    lang: 'eng',
    fontSize: 22,
    font: 'DejaVu Sans',
    lines: [
      'Contact: Sarah Whitfield',
      'Account: Maison Aurelle London',
      'Email: s.whitfield@example-mail.com',
      'Mobile: +44 20 7946 0958',
      'Card on file: 4111 1111 1111 1111',
      'Notes: prefers private appointments on Fridays.',
    ],
    sensitive: ['Sarah Whitfield', 's.whitfield@example-mail.com', '+44 20 7946 0958', '4111 1111 1111 1111'],
  },
  {
    file: 'fr-email.png',
    lang: 'fra',
    fontSize: 22,
    font: 'DejaVu Sans',
    lines: [
      'De : Théo Marchand <theo.marchand@exemple.fr>',
      'Objet : Commande spéciale pour la boutique de Cannes',
      'Bonjour, merci de rappeler la cliente au 06 12 34 56 78.',
      'IBAN pour l’acompte : FR76 3000 6000 0112 3456 7890 189',
      'Mot de passe du compte d’intégration : Aurelle#2026',
    ],
    sensitive: ['Théo Marchand', 'theo.marchand@exemple.fr', '06 12 34 56 78', 'FR76 3000 6000 0112 3456 7890 189', 'Aurelle#2026'],
  },
  {
    file: 'zh-order.png',
    lang: 'eng+chi_sim',
    fontSize: 24,
    font: 'WenQuanYi Zen Hei',
    lines: [
      '客户：刘洋',
      '电话：13812345678',
      '邮箱：liuyang.vip@example.cn',
      '身份证：11010519491231002X',
      '备注：希望在上海旗舰店提货。',
    ],
    sensitive: ['刘洋', '13812345678', 'liuyang.vip@example.cn', '11010519491231002X'],
  },
  {
    file: 'en-small-grey.png',
    lang: 'eng',
    fontSize: 13,
    font: 'DejaVu Sans',
    lines: [
      'Case 00001234 · Owner: Priya Natarajan',
      'Customer phone (212) 555-0147, SSN 536-22-8094',
      'Integration password: Spring2026!x',
    ],
    sensitive: ['Priya Natarajan', '(212) 555-0147', '536-22-8094', 'Spring2026!x'],
  },
];

/** Names a context would already know; the OCR spike has no model unless OCR_NER_MODEL is set. */
export const OCR_KNOWN_NAMES = ['Sarah Whitfield', 'Théo Marchand', '刘洋', 'Priya Natarajan'];

/** File name of the ground-truth mask for sensitive string `i` of a fixture. */
export function maskName(file: string, i: number): string {
  return file.replace('.png', `.mask-${i}.png`);
}
