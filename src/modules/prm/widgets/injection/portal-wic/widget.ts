import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalWicWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-wic',
    title: 'WIC — Wildly Important Contributions',
    description: 'Scored code contributions to Open Mercato (L1–L4, with bounty multipliers).',
    features: ['prm.dashboard.view', 'prm.wic.read_own_agency'],
    priority: 10,
    enabled: true,
  },
  Widget: PortalWicWidget,
}

export default widget
