import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalWipWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-wip',
    title: 'Work In Progress',
    description: 'Active prospects (excluding lost).',
    features: ['prm.dashboard.view'],
    priority: 5,
    enabled: true,
  },
  Widget: PortalWipWidget,
}

export default widget
