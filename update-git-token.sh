#!/bin/bash

# Script to update GitHub token in Git credential helper

echo "🔑 GitHub Token Updater"
echo "======================"
echo ""
read -p "Enter your GitHub username: " GITHUB_USER
read -sp "Enter your GitHub Personal Access Token: " GITHUB_TOKEN
echo ""

# Store credentials in Git credential helper
echo "host=github.com
protocol=https
username=$GITHUB_USER
password=$GITHUB_TOKEN" | git credential approve

echo ""
echo "✅ Token saved successfully!"
echo ""
echo "Testing connection..."
git ls-remote --heads origin main > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "✅ Connection test successful!"
else
    echo "❌ Connection test failed. Please verify your token has the correct permissions."
fi








