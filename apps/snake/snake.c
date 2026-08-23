#include "stdio.h"
#include "string.h"
#include "stdlib.h"
#include "terminal.h"
#include "delay.h"

#define W 20
#define H 20
#define MAX (W * H)

static int qx[MAX], qy[MAX];
static int qh, qt;
static int fx, fy, dir, score;

static void spawn_food(void)
{
    int occupied;
    do
    {
        fx = rand() % W;
        fy = rand() % H;
      
        occupied = 0;
        for (int i = qh;; i = (i + 1) % MAX)
        {
            if (qx[i] == fx && qy[i] == fy)
            {
                occupied = 1;
                break;
            }
            if (i == qt)
                break;
        }
    } while (occupied);
}

int main(void)
{
    int x, y;
    char ch;
    printf(CSI_CLS CSI_HOME);
    printf(CSI_HIDE);

    int playing = 1;
    while (playing)
    {
        for (x = 0; x < W + 2; x++)
        {
            printf(CSI_CUP, 1, x + 1);
            putchar('#');
            printf(CSI_CUP, H + 2, x + 1);
            putchar('#');
        }
        for (y = 0; y < H + 2; y++)
        {
            printf(CSI_CUP, y + 1, 1);
            putchar('#');
            printf(CSI_CUP, y + 1, W + 2);
            putchar('#');
        }

        printf(CSI_CUP, H + 4, 1);
        printf("Press any key to start!");

        srand(0);

        qh = qt = 0;
        qx[0] = W / 2;
        qy[0] = H / 2;
        dir = 0;
        score = 0;
        spawn_food();

        printf(CSI_CUP, qy[0] + 2, qx[0] + 2);
        putchar('O');
        printf(CSI_CUP, fy + 2, fx + 2);
        putchar('*');

        switch (getchar())
        {
        case 'w':
            dir = 3;
            break;
        case 's':
            dir = 1;
            break;
        case 'a':
            dir = 2;
            break;
        case 'd':
            dir = 0;
            break;
        default:
            break;
        }

        printf(CSI_CUP, H + 4, 1);
        printf("Score: %d                 ", score);

        int dead = 0;
        while (!dead)
        {
            if (peekchar())
            {
                int k = toupper(getchar());
                if (k == 'W')
                {
                    if (dir != 1)
                        dir = 3;
                }
                else if (k == 'S')
                {
                    if (dir != 3)
                        dir = 1;
                }
                else if (k == 'A')
                {
                    if (dir != 0)
                        dir = 2;
                }
                else if (k == 'D')
                {
                    if (dir != 2)
                        dir = 0;
                }
            }

            int nx = qx[qh] + (dir == 0 ? 1 : dir == 2 ? -1
                                                        : 0);
            int ny = qy[qh] + (dir == 1 ? 1 : dir == 3 ? -1
                                                        : 0);

            if (nx < 0 || nx >= W || ny < 0 || ny >= H)
                dead = 1;
            for (int i = qh; !dead && i != qt; i = (i + 1) % MAX)
                if (qx[i] == nx && qy[i] == ny)
                    dead = 1;
            if (dead)
                break;

            printf(CSI_CUP, qy[qh] + 2, qx[qh] + 2);
            putchar('o');
            int nh = (qh + MAX - 1) % MAX;
            qx[nh] = nx;
            qy[nh] = ny;
            qh = nh;

            if (nx == fx && ny == fy)
            {
                score++;
                printf(CSI_CUP, H + 4, 1);
                printf("Score: %d  ", score);
                spawn_food();
                printf(CSI_CUP, fy + 2, fx + 2);
                putchar('*');
            }
            else
            {
                printf(CSI_CUP, qy[qt] + 2, qx[qt] + 2);
                putchar(' ');
                qt = (qt + MAX - 1) % MAX;
            }

            printf(CSI_CUP, ny + 2, nx + 2);
            putchar('O');

            delay(100);
        }

        printf(CSI_CLS);
        printf(CSI_CUP, H / 2 + 1, W / 2 - 3);
        printf("Game Over!");
        printf(CSI_CUP, H / 2 + 3, W / 2 - 2);
        printf("Score: %d", score);
        printf(CSI_CUP, H / 2 + 5, W / 2 - 6);
        printf("Try again (Y/N) ");
        printf(CSI_SHOW);
        do
        {
            ch = (char)toupper(getchar());
        } while (ch != 'Y' && ch != 'N');

        if (ch == 'Y')
        {
            printf(CSI_CLS CSI_HOME);
            printf(CSI_HIDE);
        }
        else
            playing = 0;
    }

    printf("\n");
    printf(CSI_SHOW);
    return 0;
}