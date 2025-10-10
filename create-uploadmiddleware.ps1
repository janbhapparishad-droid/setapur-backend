# PowerShell script to create uploadMiddleware.js with multer setup

$middlewareFolder = ".\middleware"
$uploadFile = "uploadMiddleware.js"
$uploadPath = Join-Path $middlewareFolder $uploadFile

# Create middleware folder if it does not exist
if (-not (Test-Path $middlewareFolder)) {
    New-Item -ItemType Directory -Path $middlewareFolder
    Write-Output "Created folder: $middlewareFolder"
} else {
    Write-Output "Folder already exists: $middlewareFolder"
}

# Content for uploadMiddleware.js
$uploadContent = @"
const multer = require('multer');
const path = require('path');

// Storage configuration for multer to save files in uploads/ folder
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Make sure uploads folder exists
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

module.exports = upload;
"@

# Write content to uploadMiddleware.js (overwrite if exists)
Set-Content -Path $uploadPath -Value $uploadContent -Encoding UTF8

Write-Output "Created/updated file: $uploadPath"

# Create uploads folder if it does not exist
$uploadsFolder = ".\uploads"
if (-not (Test-Path $uploadsFolder)) {
    New-Item -ItemType Directory -Path $uploadsFolder
    Write-Output "Created folder: $uploadsFolder"
} else {
    Write-Output "Folder already exists: $uploadsFolder"
}
