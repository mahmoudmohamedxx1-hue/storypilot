/* Regenerate storypilot-live/STORYPILOT.md from the app bundle (deploy parity) */
import { buildSetupMd } from '../src/lib/bundle/workflow-yaml'
import { writeFileSync } from 'fs'

const md = buildSetupMd({
  repo: 'mahmoudmohamedxx1-hue/storypilot',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit',
})
writeFileSync('/home/z/my-project/storypilot-live/STORYPILOT.md', md)
console.log('STORYPILOT.md regenerated:', md.length, 'chars | drive section:', /Google Drive backup/.test(md))
