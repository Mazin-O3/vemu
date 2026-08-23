#include "stdio.h"
#include "terminal.h"

#define SCALE 10
#define S (1 << SCALE)

static int mb(int cr, int ci)
{
    int zr = 0, zi = 0;
    int n;
    for (n = 1; n <= 255; n++)
    {
        int zr2 = (zr * zr) >> SCALE;
        int zi2 = (zi * zi) >> SCALE;
        if (zr2 + zi2 > 4 * S)
            return n;
        int t = zr;
        zr = zr2 - zi2 + cr;
        zi = ((t * zi) >> (SCALE - 1)) + ci;
    }
    return 0;
}

int main(void)
{
    int cols = SCREEN_WIDTH, rows = SCREEN_ROWS;
    int row, col;
    for (row = 0; row < rows; row++)
    {
        for (col = 0; col < cols; col++)
        {
            int cr = -2 * S + col * (3 * S) / cols;
            int ci = -S + row * (2 * S) / rows;
            int n = mb(cr, ci);
            char c;
            if (n == 0)
                c = '@';
            else if (n > 240)
                c = ' ';
            else if (n > 120)
                c = '.';
            else if (n > 60)
                c = ':';
            else if (n > 30)
                c = '-';
            else if (n > 15)
                c = '=';
            else if (n > 8)
                c = '+';
            else if (n > 4)
                c = '#';
            else
                c = '%';
            putchar(c);
        }
    }
    return 0;
}
