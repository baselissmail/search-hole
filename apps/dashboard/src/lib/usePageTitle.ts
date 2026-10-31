// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react'

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · search-hole`
  }, [title])
}
