import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalWicWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-wic',
    title: 'Work In Code',
    description: 'Code contributions to OM repositories per member.',
    features: ['prm.dashboard.view', 'prm.wic.read_own_agency'],
    priority: 10,
    enabled: true,
  },
  Widget: PortalWicWidget,
}

export default widget
