// Labelled test sentences for masking, from spike 1. All people, numbers and secrets are invented.
// Markup: [[TYPE|text]] marks one gold entity. Sentences with no markup must stay untouched.
//
// ORG and LOCATION are labelled for information only: masking leaves them visible (MA1).

export interface Sample {
  lang: 'en' | 'fr' | 'zh';
  text: string;
  gold: { start: number; end: number; type: string; value: string }[];
}

const RAW: { lang: Sample['lang']; text: string }[] = [
  // English
  { lang: 'en', text: 'Please call [[PERSON|Sarah Whitfield]] on [[PHONE|+44 20 7946 0958]] before the Service Cloud go-live.' },
  { lang: 'en', text: 'The VIP client [[PERSON|Jonathan Mercer]] ([[EMAIL|j.mercer@example-mail.com]]) wants his order shipped to [[ADDRESS|221 Baker Street, London NW1 6XE]].' },
  { lang: 'en', text: 'Refund the deposit to IBAN [[IBAN|GB33 BUKB 2020 1555 5555 55]] for customer [[PERSON|Emily Carter]].' },
  { lang: 'en', text: 'Case 00001234 was opened by [[PERSON|Michael O\'Brien]] after his card [[CARD|4111 1111 1111 1111]] was declined in the [[LOCATION|Dubai]] boutique.' },
  { lang: 'en', text: 'Integration user password: [[SECRET|Spring2026!x]] and the API token is [[SECRET|ATATT3xFfGF0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV]].' },
  { lang: 'en', text: 'Store manager [[PERSON|Priya Natarajan]] reported that [[PERSON|Tom]] keeps the clienteling notes in a spreadsheet.' },
  { lang: 'en', text: 'Her SSN [[NATIONAL_ID|536-22-8094]] was pasted into the Description field of the Contact record.' },
  { lang: 'en', text: 'The middleware at [[IP|10.24.3.17]] calls Salesforce with session [[SECRET|00D5g000004XyZq!AQ8AQKj3n2s9dD7f8g9h0jK1lM2nO3pQ4rS5tU6]].' },
  { lang: 'en', text: 'As a sales associate in [[LOCATION|New York]], I want to see a client\'s preferred sizes so that I can prepare a fitting.' },
  { lang: 'en', text: '[[PERSON|Kenji Watanabe]] from [[ORG|Maison Aurelle]] approved the Opportunity for the [[LOCATION|Tokyo]] flagship, call him at [[PHONE|(212) 555-0147]].' },
  { lang: 'en', text: 'Send the contract to [[EMAIL|legal.team@aurelle-group.example]] and copy [[PERSON|Ana Lucía Fernández]].' },
  { lang: 'en', text: 'Our GitHub token [[SECRET|ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8]] leaked in the Jira comment.' },
  // French
  { lang: 'fr', text: 'Merci de rappeler Mme [[PERSON|Hélène Garnier]] au [[PHONE|06 12 34 56 78]] avant la mise en production.' },
  { lang: 'fr', text: 'Le client [[PERSON|Jean-Baptiste Lefèvre]] habite au [[ADDRESS|14 rue du Faubourg Saint-Honoré, 75008 Paris]].' },
  { lang: 'fr', text: 'Virement à effectuer sur l\'IBAN [[IBAN|FR76 3000 6000 0112 3456 7890 189]] au nom de [[PERSON|Camille Rousseau]].' },
  { lang: 'fr', text: 'Son numéro de sécurité sociale [[NATIONAL_ID|2 85 07 75 116 238 95]] figure dans la pièce jointe.' },
  { lang: 'fr', text: 'En tant que conseillère de vente à [[LOCATION|Lyon]], je veux voir l\'historique d\'achat du client pour lui proposer une pièce adaptée.' },
  { lang: 'fr', text: '[[PERSON|Théo Marchand]] ([[EMAIL|theo.marchand@exemple.fr]]) a validé le flux Apex pour [[ORG|Maison Aurelle]].' },
  { lang: 'fr', text: 'Le mot de passe est [[SECRET|Aurelle#2026]] pour le compte d\'intégration.' },
  { lang: 'fr', text: 'La directrice de la boutique de [[LOCATION|Cannes]], [[PERSON|Sophie Nguyen]], demande un rapport sur les Opportunity perdues.' },
  { lang: 'fr', text: 'Appeler M. [[PERSON|Karim Benali]] au [[PHONE|+33 1 42 68 53 00]] concernant sa commande.' },
  { lang: 'fr', text: 'La carte [[CARD|5555 5555 5555 4444]] de [[PERSON|Louise Martin]] a été refusée.' },
  { lang: 'fr', text: '[[PERSON|Antoine]] a dit que [[PERSON|Margaux]] gère les retours en boutique.' },
  { lang: 'fr', text: 'Le serveur [[IP|192.168.12.40]] expose l\'API Salesforce sans chiffrement.' },
  // Chinese
  { lang: 'zh', text: '请联系客户[[PERSON|王伟]]，电话[[PHONE|13812345678]]，确认[[LOCATION|上海]]旗舰店的订单。' },
  { lang: 'zh', text: '客户[[PERSON|李娜]]的邮箱是[[EMAIL|lina.vip@example.cn]]，她希望在[[LOCATION|北京]]提货。' },
  { lang: 'zh', text: '[[PERSON|张敏]]的身份证号码是[[NATIONAL_ID|11010519491231002X]]，已上传到附件。' },
  { lang: 'zh', text: '收货地址：[[ADDRESS|上海市静安区南京西路1266号]]，收件人[[PERSON|陈静]]。' },
  { lang: 'zh', text: '作为[[LOCATION|成都]]门店的销售顾问，我希望查看客户的尺码偏好，以便提前准备。' },
  { lang: 'zh', text: '集成用户的密码：[[SECRET|Aurelle2026cn]]，请勿外传。' },
  { lang: 'zh', text: '[[PERSON|刘洋]]经理批准了[[ORG|奥瑞尔集团]]的商机，联系电话[[PHONE|+86 21 6288 1234]]。' },
  { lang: 'zh', text: '客户[[PERSON|赵磊]]的银行卡[[CARD|6222 0212 3456 7890 128]]支付失败。' },
  { lang: 'zh', text: '[[PERSON|黄晓明]]和[[PERSON|周婷]]负责[[LOCATION|香港]]门店的客户回访。' },
  { lang: 'zh', text: '中间件服务器[[IP|172.16.8.21]]每小时调用一次 Salesforce 接口。' },
  { lang: 'zh', text: '请把合同发送给[[EMAIL|legal@aurelle.example.cn]]，并抄送[[PERSON|孙丽]]。' },
  { lang: 'zh', text: '客户[[PERSON|吴昊]]住在[[ADDRESS|广州市天河区天河路385号]]。' },
  // No personal data: domain vocabulary that must not be masked.
  { lang: 'en', text: 'The token is valid until Friday, and the password policy is strict.' },
  { lang: 'en', text: 'The secretary is in the head office; the API key rotation runs monthly.' },
  { lang: 'fr', text: 'Le mot de passe est obligatoire pour se connecter à Experience Cloud.' },
  { lang: 'en', text: 'Card payments are captured on Order 00012345 within 2 days.' },
  { lang: 'en', text: 'As a Service Cloud agent, I want the Case to link to the Account and Contact so that I can see the Opportunity history.' },
  { lang: 'en', text: 'Use a record-triggered Flow on Order and an Apex class to sync with MuleSoft and Data Cloud.' },
  { lang: 'en', text: 'Agentforce should summarise Knowledge articles; Einstein scores Leads in Sales Cloud.' },
  { lang: 'en', text: 'Publish the epic to Jira and the design to Confluence, then open a pull request on GitHub.' },
  { lang: 'fr', text: 'En tant qu\'agent Service Cloud, je veux lier le Case au compte (Account) pour voir les Opportunity.' },
  { lang: 'fr', text: 'Créer un Flow déclenché sur Order et une classe Apex pour synchroniser Commerce Cloud.' },
  { lang: 'zh', text: '在 Service Cloud 中，Case 需要关联 Account 和 Contact，并同步到 Data Cloud。' },
  { lang: 'zh', text: '使用 Flow 和 Apex 在 Experience Cloud 上展示 Opportunity。' },
];

function parse(lang: Sample['lang'], raw: string): Sample {
  const gold: Sample['gold'] = [];
  let text = '';
  const re = /\[\[([A-Z_]+)\|([^\]]+)\]\]/g;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    text += raw.slice(last, m.index);
    const start = text.length;
    text += m[2];
    gold.push({ start, end: text.length, type: m[1]!, value: m[2]! });
    last = m.index! + m[0].length;
  }
  text += raw.slice(last);
  return { lang, text, gold };
}

export const SAMPLES: Sample[] = RAW.map((r) => parse(r.lang, r.text));

/** Types the product must mask. ORG and LOCATION are reported but not required. */
export const REQUIRED_TYPES = ['PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'IBAN', 'CARD', 'NATIONAL_ID', 'SECRET', 'IP'];

/**
 * Names a context would already know (for example, users pulled from the org or Jira).
 * Only some of the people above are listed, to measure what the dictionary adds.
 */
export const KNOWN_NAMES = ['Sarah Whitfield', 'Priya Natarajan', 'Théo Marchand', 'Sophie Nguyen', '刘洋', '孙丽'].map((value) => ({
  value,
  type: 'PERSON',
}));
