'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CaseStudyForm } from '../caseStudyForm'

type Props = { params: { orgSlug: string } }

export default function NewCaseStudyPage({ params }: Props) {
  const t = useT()
  const router = useRouter()
  const orgSlug = params.orgSlug
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
