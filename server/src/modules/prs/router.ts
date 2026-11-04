
import { Router } from 'express'
import type { MyPrsResponse, PrDetail } from 'shared'
import { requireSession } from '../../middleware/session'
import {
  getPrForUser,
  getPrDetailRow,
  listReviewRequests,
  listLatestReviews,
  listMyPrs,
} from '../../db/prs'
import { computeFlags } from '../../flags'

const router = Router()
router.get('/api/my-prs', requireSession, async (req, res, next) => {
  try {
    const userId = req.user!.id
    const prs = await listMyPrs(userId)
    const now = new Date()

    const response: MyPrsResponse = {
      items: prs.map((pr) => ({
        id: Number(pr.id),
        repo: pr.repo_full_name,
        number: pr.number,
        title: pr.title,
        url: `https://github.com/${pr.repo_full_name}/pull/${pr.number}`,
        authorLogin: req.user!.login,
        state: pr.state,
        isDraft: pr.is_draft,
        linesChanged: pr.lines_changed,
        flags: computeFlags(pr, now),
      })),
    }

    res.status(200).json(response)
  } catch (error) {
    next(error)
  }
})

router.get('/api/my-prs/:id', requireSession, async (req, res, next) => {
  try {
    const rawId = req.params.id

    if (typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId)) {
      res.status(400).json({ error: 'Invalid PR ID' })
      return
    }

    const prId = Number(rawId)

    if (!Number.isSafeInteger(prId)) {
      res.status(400).json({ error: 'Invalid PR ID' })
      return
    }

    const userId = req.user!.id

    // Verify repository access before fetching detail data.
    const accessResult = await getPrForUser(userId, prId)

    if (accessResult === 'not_found') {
      res.status(404).json({ error: 'PR not found' })
      return
    }

    if (accessResult === 'forbidden') {
      res.status(403).json({
        error: "You don't have access to this repository",
      })
      return
    }

    const [pr, reviewRequestRows, reviewRows] = await Promise.all([
      getPrDetailRow(prId),
      listReviewRequests(prId),
      listLatestReviews(prId),
    ])

    if (!pr) {
      res.status(404).json({ error: 'PR not found' })
      return
    }

    const response: PrDetail = {
      id: Number(pr.id),
      repo: pr.repo_full_name,
      number: pr.number,
      title: pr.title,
      url: `https://github.com/${pr.repo_full_name}/pull/${pr.number}`,
      authorLogin: pr.author_login,
      state: pr.state,
      isDraft: pr.is_draft,
      linesChanged: pr.lines_changed,
      flags: computeFlags(pr, new Date()),

      reviewRequests: reviewRequestRows.map((row) => ({
        reviewerLogin: row.reviewer_login,
        requestedAt: row.requested_at.toISOString(),
      })),

      reviews: reviewRows.map((row) => ({
        reviewerLogin: row.reviewer_login,
        state: row.state,
        submittedAt: row.submitted_at.toISOString(),
      })),
    }

    res.status(200).json(response)
  } catch (error) {
    next(error)
  }
})

export default router
