// Owned by Mallikarjun
// Seed data for development/staging
// Development seed entry point
// Owned by Mallikarjun

import 'dotenv/config'
import { seedDevelopmentData } from './dev'

async function main(): Promise<void> {
  try {
    await seedDevelopmentData()
  } catch (error) {
    console.error('Seed execution failed:', error)
    process.exitCode = 1
  }
}

void main()