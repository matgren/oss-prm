import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'prm',
  title: 'Partner Relationship Management',
  version: '0.1.0',
  description:
    'Foundation module for the Partner Relationship Management app: agencies, members, invitations, and the portal for partner-facing flows.',
  author: 'Open Mercato Team',
  license: 'MIT',
  requires: ['customer_accounts', 'directory', 'notifications', 'dictionaries', 'workflows'],
}

export { features } from './acl'
