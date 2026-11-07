// A small draw.io diagram (uncompressed mxfile XML) used by the Confluence check.
export const DIAGRAM_NAME = 'sf-agent-po-check';

const box = (id: string, label: string, x: number) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="${x}" y="40" width="140" height="60" as="geometry"/></mxCell>`;
const arrow = (id: string, s: string, t: string) =>
  `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

export const DRAWIO_XML = `<mxfile host="sf-agent-po" type="device"><diagram id="d1" name="Page-1"><mxGraphModel dx="800" dy="400" grid="1" gridSize="10" page="1" pageWidth="827" pageHeight="300"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${box('a', 'Account', 40)}${box('c', 'Contact', 260)}${box('o', 'Opportunity', 480)}${arrow('e1', 'c', 'a')}${arrow('e2', 'o', 'a')}</root></mxGraphModel></diagram></mxfile>`;
