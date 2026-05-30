const fs = require('fs');
const file = 'c:/Users/AX/Desktop/G_LAWNS/components/PropertyMapView.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/draft: PropertyDetails;\s*editing: boolean;\s*\};/g, 'draft: PropertyDetails;\n};');
code = code.replace(/const \[editing, setEditing\] = useState\(false\);\n\s*/g, '');
code = code.replace(/draft: \{ \.\.\.draft \},\s*editing,\s*\}\),/g, 'draft: { ...draft },\n    }),');
code = code.replace(/\[properties, selectedIds, selected, panelOpen, draft, editing\]/g, '[properties, selectedIds, selected, panelOpen, draft]');
code = code.replace(/setPanelOpen\(snapshot\.panelOpen\);\s*setEditing\(snapshot\.editing\);/g, 'setPanelOpen(snapshot.panelOpen);');
code = code.replace(/setPanelOpen\(false\);\s*setEditing\(false\);/g, 'setPanelOpen(false);');
code = code.replace(/setPanelOpen\(false\);\s*setSelected\(null\);\s*setEditing\(false\);/g, 'setPanelOpen(false);\n      setSelected(null);');
code = code.replace(/setPanelOpen\(true\);\s*setEditing\(false\);/g, 'setPanelOpen(true);');
code = code.replace(/setDraft\(saved\);\s*setEditing\(false\);\s*setSaving\(false\);/g, 'setDraft(saved);\n    setSaving(false);');

code = code.replace(/const bulkBusy = bulkSaving \|\| bulkDeleting;/g, `const bulkBusy = bulkSaving || bulkDeleting;

  const isDirty = selected ? (
    draft.client_name !== selected.client_name ||
    draft.phone !== selected.phone ||
    draft.email !== selected.email ||
    draft.mowing_price !== selected.mowing_price ||
    draft.status !== selected.status ||
    JSON.stringify(draft.services || []) !== JSON.stringify(selected.services || [])
  ) : false;`);

fs.writeFileSync(file, code);
console.log('Cleanups done');