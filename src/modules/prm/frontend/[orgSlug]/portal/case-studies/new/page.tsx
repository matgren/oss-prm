'use client'
import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CaseStudyForm } from '../caseStudyForm'

export default function NewCaseStudyPage() {
  const t = useT()
  const params = useParams<{ orgSlug: string }>()
  const router = useRouter()
  const orgSlug = params?.orgSlug ?? ''
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t('prm.portal.caseStudies.btn.new', 'New case study')}</h1>
      </header>
      <CaseStudyForm
        mode="create"
        onSuccess={(id: string) => router.push(`/${orgSlug}/portal/case-studies/${id}`)}
      />
    </div>
  )
}
