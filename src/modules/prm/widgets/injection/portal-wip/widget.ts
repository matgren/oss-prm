import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalWipWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-wip',
    title: 'WIP — Wildly Important Prospects',
    description: "Agency-owned prospects you've registered.",
    features: ['prm.dashboard.view'],
    priority: 5,
    enabled: true,
  },
  Widget: PortalWipWidget,
}

export default widget
