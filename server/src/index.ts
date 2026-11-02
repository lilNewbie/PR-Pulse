import { configDotenv } from 'dotenv'
import { resolve } from 'path'
configDotenv({ path: resolve(__dirname, '../../.env') })

import app from './app'

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
