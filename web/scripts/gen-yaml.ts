import { buildWorkflowYaml } from '../src/lib/bundle/workflow-yaml'
const yaml = buildWorkflowYaml({ sheetId: '1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4', flpModel: 'glm-5.3-flash', voice: 'ar-EG-ShakirNeural' })
process.stdout.write(yaml)
