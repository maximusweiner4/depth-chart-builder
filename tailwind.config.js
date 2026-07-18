/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        'display': ['Bebas Neue', 'sans-serif'],
        'body': ['Plus Jakarta Sans', 'sans-serif'],
      }
    }
  },
  plugins: [],
}
